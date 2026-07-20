use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use getrandom::fill as random_fill;
use keyring::{Entry, Error as KeyringError};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::command;

const KEYCHAIN_SERVICE: &str = "MochiPaw";
const INSTALLATION_ACCOUNT: &str = "runtime-installation-secret";
const DEVICE_SIGNING_ACCOUNT: &str = "runtime-ed25519-private-key";
const LEASE_REFRESH_SKEW_SECONDS: u64 = 10 * 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallationIdentity {
    install_id_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedicatedEncryptedFile {
    path: String,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDedicatedRuntimeInput {
    model_path: String,
    package_id: String,
    activation_token: String,
    author_proof: Value,
    encrypted_files: Vec<DedicatedEncryptedFile>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredRuntimeLease {
    lease_token: String,
    lease_id: String,
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLeaseReport {
    pub lease_id: String,
    pub expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDedicatedRuntimeEventInput {
    package_id: String,
    event_type: String,
    app_version: Option<String>,
    platform: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRefreshRequest {
    package_id: String,
    install_id_hash: String,
    device_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRequest {
    activation_token: String,
    package_id: String,
    install_id_hash: String,
    device_public_key: String,
    author_proof: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceRequest {
    package_id: String,
    path: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceResponse {
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEventRequest {
    package_id: String,
    event_type: String,
    install_id_hash: String,
    app_version: Option<String>,
    platform: Option<String>,
}

struct RuntimeIdentity {
    install_id_hash: String,
    device_public_key: String,
    signing_key: SigningKey,
}

#[command]
pub fn runtime_installation_identity() -> Result<RuntimeInstallationIdentity, String> {
    let identity = runtime_identity()?;
    Ok(RuntimeInstallationIdentity {
        install_id_hash: identity.install_id_hash,
    })
}

#[command]
pub fn prepare_dedicated_runtime(
    input: PrepareDedicatedRuntimeInput,
) -> Result<RuntimeLeaseReport, String> {
    let package_id = required_field(&input.package_id, "package ID")?;
    let identity = runtime_identity()?;
    let client = runtime_client()?;
    let lease = obtain_runtime_lease(
        &client,
        &identity,
        package_id,
        &input.activation_token,
        &input.author_proof,
    )?;
    decrypt_registered_resources(
        &client,
        &identity,
        &lease,
        &input.model_path,
        package_id,
        &input.encrypted_files,
    )?;
    store_lease(package_id, &lease)?;
    Ok(RuntimeLeaseReport {
        lease_id: lease.lease_id,
        expires_at: lease.expires_at,
    })
}

#[command]
pub fn record_dedicated_runtime_event(
    input: RecordDedicatedRuntimeEventInput,
) -> Result<(), String> {
    let package_id = required_field(&input.package_id, "package ID")?;
    let identity = runtime_identity()?;
    let lease = read_lease(package_id)?
        .ok_or_else(|| "Dedicated package runtime authorization is unavailable.".to_string())?;
    if lease.expires_at <= now_ts() {
        return Err("Dedicated package runtime authorization has expired.".to_string());
    }
    let body = RuntimeEventRequest {
        package_id: package_id.to_string(),
        event_type: required_field(&input.event_type, "runtime event type")?.to_string(),
        install_id_hash: identity.install_id_hash.clone(),
        app_version: input.app_version.filter(|value| !value.trim().is_empty()),
        platform: input.platform.filter(|value| !value.trim().is_empty()),
    };
    let response = signed_post(
        &runtime_client()?,
        &identity,
        "/runtime/events",
        &body,
        Some(&lease.lease_token),
    )?;
    ensure_success(response, "Could not record dedicated runtime event")?;
    Ok(())
}

fn obtain_runtime_lease(
    client: &Client,
    identity: &RuntimeIdentity,
    package_id: &str,
    activation_token: &str,
    author_proof: &Value,
) -> Result<StoredRuntimeLease, String> {
    if let Some(lease) = read_lease(package_id)? {
        if lease.expires_at > now_ts() + LEASE_REFRESH_SKEW_SECONDS {
            return Ok(lease);
        }
    }

    let refresh_body = LeaseRefreshRequest {
        package_id: package_id.to_string(),
        install_id_hash: identity.install_id_hash.clone(),
        device_public_key: identity.device_public_key.clone(),
    };
    let refresh = signed_post(
        client,
        identity,
        "/runtime/leases/refresh",
        &refresh_body,
        None,
    )?;
    if refresh.status().is_success() {
        return parse_response(refresh, "Dedicated package lease refresh");
    }
    if refresh.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!(
            "Dedicated package lease refresh failed with HTTP {}.",
            refresh.status()
        ));
    }

    let activation_body = ActivationRequest {
        activation_token: required_field(activation_token, "activation token")?.to_string(),
        package_id: package_id.to_string(),
        install_id_hash: identity.install_id_hash.clone(),
        device_public_key: identity.device_public_key.clone(),
        author_proof: author_proof.clone(),
    };
    parse_response(
        signed_post(
            client,
            identity,
            "/runtime/activations",
            &activation_body,
            None,
        )?,
        "Dedicated package activation",
    )
}

fn decrypt_registered_resources(
    client: &Client,
    identity: &RuntimeIdentity,
    lease: &StoredRuntimeLease,
    model_path: &str,
    package_id: &str,
    encrypted_files: &[DedicatedEncryptedFile],
) -> Result<(), String> {
    let root = PathBuf::from(model_path);
    let marker = root.join("mochi-control").join("decryption.json");
    if marker.exists() {
        return Ok(());
    }

    for file in encrypted_files {
        let relative = safe_relative_path(&file.path)?;
        let source = root.join(relative);
        let ciphertext = fs::read(&source)
            .map_err(|err| format!("Could not read controlled package resource: {err}"))?;
        let request = ResourceRequest {
            package_id: package_id.to_string(),
            path: file.path.clone(),
            nonce: file.nonce.clone(),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        };
        let resource: ResourceResponse = parse_response(
            signed_post(
                client,
                identity,
                "/runtime/resources",
                &request,
                Some(&lease.lease_token),
            )?,
            "Dedicated package resource authorization",
        )?;
        let plaintext = URL_SAFE_NO_PAD
            .decode(resource.data_base64)
            .map_err(|_| "Dedicated package resource response is invalid.".to_string())?;
        fs::write(&source, plaintext)
            .map_err(|err| format!("Could not materialize controlled package resource: {err}"))?;
    }

    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create controlled package state directory: {err}"))?;
    }
    fs::write(
        marker,
        format!(
            "{{\"schemaVersion\":1,\"packageId\":{},\"decryptedAt\":{}}}",
            serde_json::to_string(package_id).unwrap_or_default(),
            serde_json::to_string(&now_ts()).unwrap_or_default()
        ),
    )
    .map_err(|err| format!("Could not save controlled package state: {err}"))?;
    Ok(())
}

fn signed_post<T: Serialize>(
    client: &Client,
    identity: &RuntimeIdentity,
    path: &str,
    body: &T,
    lease_token: Option<&str>,
) -> Result<Response, String> {
    let encoded = serde_json::to_vec(body)
        .map_err(|err| format!("Could not prepare runtime request: {err}"))?;
    let timestamp = now_ts();
    let request_id = random_url_safe(24)?;
    let body_hash = URL_SAFE_NO_PAD.encode(Sha256::digest(&encoded));
    let payload =
        format!("mochi-runtime-request-v1\nPOST\n{path}\n{timestamp}\n{request_id}\n{body_hash}");
    let signature =
        URL_SAFE_NO_PAD.encode(identity.signing_key.sign(payload.as_bytes()).to_bytes());
    let mut request = client
        .post(runtime_url(path)?)
        .header("content-type", "application/json")
        .header("x-mochi-request-timestamp", timestamp.to_string())
        .header("x-mochi-request-id", request_id)
        .header("x-mochi-device-signature", signature)
        .body(encoded);
    if let Some(token) = lease_token {
        request = request.bearer_auth(token);
    }
    request
        .send()
        .map_err(|err| format!("Could not reach runtime authorization service: {err}"))
}

fn parse_response<T: for<'de> Deserialize<'de>>(
    response: Response,
    context: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!("{context} failed with HTTP {}.", response.status()));
    }
    response
        .json()
        .map_err(|err| format!("{context} returned an invalid response: {err}"))
}

fn ensure_success(response: Response, context: &str) -> Result<(), String> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("{context} failed with HTTP {}.", response.status()))
    }
}

fn runtime_identity() -> Result<RuntimeIdentity, String> {
    let install_secret = read_or_create_secret(INSTALLATION_ACCOUNT, 32)?;
    let private_key = read_or_create_secret(DEVICE_SIGNING_ACCOUNT, 32)?;
    let secret: [u8; 32] = private_key
        .as_slice()
        .try_into()
        .map_err(|_| "Stored device signing key is invalid.".to_string())?;
    let signing_key = SigningKey::from_bytes(&secret);
    Ok(RuntimeIdentity {
        install_id_hash: URL_SAFE_NO_PAD.encode(Sha256::digest(install_secret)),
        device_public_key: URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes()),
        signing_key,
    })
}

fn read_or_create_secret(account: &str, bytes: usize) -> Result<Vec<u8>, String> {
    if let Some(encoded) = read_secret(account)? {
        let value = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Stored runtime credential is invalid.".to_string())?;
        if value.len() == bytes {
            return Ok(value);
        }
        return Err("Stored runtime credential has an invalid length.".to_string());
    }
    let mut value = vec![0_u8; bytes];
    random_fill(&mut value).map_err(|err| format!("Could not create runtime credential: {err}"))?;
    write_secret(account, &URL_SAFE_NO_PAD.encode(&value))?;
    Ok(value)
}

fn lease_account(package_id: &str) -> String {
    format!(
        "runtime-lease-{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(package_id.as_bytes()))
    )
}

fn store_lease(package_id: &str, lease: &StoredRuntimeLease) -> Result<(), String> {
    let serialized = serde_json::to_string(lease)
        .map_err(|err| format!("Could not store runtime authorization: {err}"))?;
    write_secret(&lease_account(package_id), &serialized)
}

fn read_lease(package_id: &str) -> Result<Option<StoredRuntimeLease>, String> {
    let Some(raw) = read_secret(&lease_account(package_id))? else {
        return Ok(None);
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|_| "Stored runtime authorization is invalid.".to_string())
}

fn safe_relative_path(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("Controlled package resource path is invalid.".to_string());
    }
    Ok(path)
}

fn required_field<'a>(value: &'a str, name: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("Dedicated package {name} is missing."))
    } else {
        Ok(value)
    }
}

fn runtime_client() -> Result<Client, String> {
    Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("Could not create runtime authorization client: {err}"))
}

fn runtime_url(path: &str) -> Result<String, String> {
    let base = std::env::var("MOCHI_RUNTIME_API_BASE")
        .unwrap_or_else(|_| "https://www.catpithos.top".to_string());
    let base = base.trim_end_matches('/');
    if !base.starts_with("https://")
        && !base.starts_with("http://127.0.0.1")
        && !base.starts_with("http://localhost")
    {
        return Err("Runtime authorization service URL must use HTTPS.".to_string());
    }
    Ok(format!("{base}{path}"))
}

fn credential(account: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|err| format!("System Keychain is unavailable: {err}"))
}

fn write_secret(account: &str, value: &str) -> Result<(), String> {
    credential(account)?
        .set_password(value)
        .map_err(|err| format!("Could not save runtime credential securely: {err}"))
}

fn read_secret(account: &str) -> Result<Option<String>, String> {
    match credential(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("Could not read runtime credential securely: {err}")),
    }
}

fn random_url_safe(byte_len: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_len];
    random_fill(&mut bytes)
        .map_err(|err| format!("Could not create runtime request identifier: {err}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
