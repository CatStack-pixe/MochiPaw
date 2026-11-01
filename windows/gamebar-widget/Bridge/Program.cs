using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Windows.ApplicationModel;
using Windows.ApplicationModel.AppService;
using Windows.Foundation.Collections;

namespace MochiPaw.GameBarBridge;

internal static class Program
{
    private const string PipeName = "MochiPaw.GameBarOverlay";
    private const string AppServiceName = "com.catstack.mochipaw.overlay";
    private static readonly CancellationTokenSource Shutdown = new();

    private static async Task<int> Main()
    {
        using var mutex = new Mutex(true, @"Local\MochiPaw.GameBarBridge", out var firstInstance);
        if (!firstInstance) return 0;

        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            Shutdown.Cancel();
        };

        while (!Shutdown.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.InOut,
                    maxNumberOfServerInstances: 1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(Shutdown.Token);

                using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true)
                {
                    AutoFlush = true,
                };

                var line = await reader.ReadLineAsync(Shutdown.Token);
                var response = await ForwardToWidgetAsync(line);
                await writer.WriteLineAsync(JsonSerializer.Serialize(response));
            }
            catch (OperationCanceledException) when (Shutdown.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                await Task.Delay(250, Shutdown.Token).ContinueWith(_ => { }, TaskScheduler.Default);
            }
        }

        return 0;
    }

    private static async Task<Dictionary<string, object?>> ForwardToWidgetAsync(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return new Dictionary<string, object?> { ["accepted"] = false, ["error"] = "empty request" };
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var request = ToValueSet(document.RootElement);
            using var connection = new AppServiceConnection
            {
                AppServiceName = AppServiceName,
                PackageFamilyName = Package.Current.Id.FamilyName,
            };

            var connectionStatus = await connection.OpenAsync();
            if (connectionStatus != AppServiceConnectionStatus.Success)
            {
                return new Dictionary<string, object?>
                {
                    ["accepted"] = false,
                    ["error"] = $"AppService connection failed: {connectionStatus}",
                };
            }

            var response = await connection.SendMessageAsync(request);
            if (response.Status != AppServiceResponseStatus.Success)
            {
                return new Dictionary<string, object?>
                {
                    ["accepted"] = false,
                    ["error"] = $"AppService request failed: {response.Status}",
                };
            }

            return response.Message.ToDictionary(pair => pair.Key, pair => (object?)pair.Value);
        }
        catch (Exception error)
        {
            return new Dictionary<string, object?>
            {
                ["accepted"] = false,
                ["error"] = error.Message,
            };
        }
    }

    private static ValueSet ToValueSet(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("IPC request must be a JSON object.");

        var values = new ValueSet();
        foreach (var property in element.EnumerateObject())
        {
            object? value = property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Number when property.Value.TryGetInt32(out var integer) => integer,
                JsonValueKind.Number => property.Value.GetDouble(),
                _ => null,
            };
            if (value is not null) values[property.Name] = value;
        }
        return values;
    }
}
