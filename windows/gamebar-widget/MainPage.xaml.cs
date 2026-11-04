using Microsoft.Gaming.XboxGameBar;
using Microsoft.Web.WebView2.Core;
using System;
using Windows.ApplicationModel;
using Windows.Data.Json;
using Windows.Foundation.Collections;
using Windows.Storage;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Navigation;

namespace MochiPaw.GameBarWidget
{
    public sealed partial class MainPage : Page
    {
        private XboxGameBarWidget widget;
        private uint targetFps = 60;
        private bool overlayEnabled;
        private bool targetActive;
        private string selectedModelId = "standard";
        private int actualFps = -1;
        private bool live2DReady;
        private bool? lastPostedVisibility;
        private uint? lastPostedTargetFps;
        private string lastPostedModelId;
        private DispatcherTimer stateTimer;

        public MainPage()
        {
            InitializeComponent();
            _ = InitializeLive2DViewAsync();
        }

        private async System.Threading.Tasks.Task InitializeLive2DViewAsync()
        {
            try
            {
                Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00FFFFFF");
                await Live2DView.EnsureCoreWebView2Async();
                var webRoot = System.IO.Path.Combine(
                    Package.Current.InstalledLocation.Path,
                    "Web");
                Live2DView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "mochipaw.local",
                    webRoot,
                    CoreWebView2HostResourceAccessKind.Allow);
                Live2DView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                Live2DView.CoreWebView2.NavigationCompleted += OnLive2DNavigationCompleted;
                Live2DView.CoreWebView2.Navigate("https://mochipaw.local/src/gamebar/index.html");
            }
            catch (Exception error)
            {
                TargetText.Text = $"WebView2 initialization failed: {error.Message}";
            }
        }

        protected override void OnNavigatedTo(NavigationEventArgs e)
        {
            widget = e.Parameter as XboxGameBarWidget;
            if (widget != null)
            {
                widget.VisibleChanged += WidgetVisibleChanged;
                widget.WindowBoundsChanged += WidgetWindowBoundsChanged;
            }

            _ = RefreshStateAsync();
            stateTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            stateTimer.Tick += StateTimerTick;
            stateTimer.Start();
        }

        protected override void OnNavigatedFrom(NavigationEventArgs e)
        {
            if (stateTimer != null)
            {
                stateTimer.Stop();
                stateTimer.Tick -= StateTimerTick;
                stateTimer = null;
            }
            if (widget != null)
            {
                widget.VisibleChanged -= WidgetVisibleChanged;
                widget.WindowBoundsChanged -= WidgetWindowBoundsChanged;
            }
            if (Live2DView.CoreWebView2 != null)
            {
                Live2DView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                Live2DView.CoreWebView2.NavigationCompleted -= OnLive2DNavigationCompleted;
            }
            base.OnNavigatedFrom(e);
        }

        private void OnLive2DNavigationCompleted(
            CoreWebView2 sender,
            CoreWebView2NavigationCompletedEventArgs args)
        {
            Live2DView.Visibility = args.IsSuccess ? Visibility.Visible : Visibility.Collapsed;
            if (!args.IsSuccess)
            {
                TargetText.Text = $"Live2D widget load failed: {args.WebErrorStatus}";
                return;
            }
            ApplyOverlayState();
        }

        private void OnWebMessageReceived(
            CoreWebView2 sender,
            CoreWebView2WebMessageReceivedEventArgs args)
        {
            try
            {
                var message = JsonObject.Parse(args.WebMessageAsJson);
                if (!message.TryGetValue("type", out var type)) return;

                switch (type.GetString())
                {
                    case "widget-ready":
                        live2DReady = true;
                        lastPostedVisibility = null;
                        lastPostedTargetFps = null;
                        lastPostedModelId = null;
                        ApplyOverlayState();
                        break;
                    case "fps-stat":
                        if (message.TryGetValue("actualFPS", out var actualValue))
                        {
                            actualFps = (int)Math.Round(actualValue.GetNumber());
                            UpdateStatus();
                        }
                        break;
                }
            }
            catch (Exception error)
            {
                TargetText.Text = $"Invalid Live2D IPC message: {error.Message}";
            }
        }

        private void WidgetVisibleChanged(XboxGameBarWidget sender, object args)
        {
            ApplyOverlayState();
        }

        private void WidgetWindowBoundsChanged(XboxGameBarWidget sender, object args)
        {
            TargetText.Text = $"Widget {sender.WindowBounds.Width:0}×{sender.WindowBounds.Height:0}";
        }

        private async System.Threading.Tasks.Task RefreshStateAsync()
        {
            try
            {
                var response = await OverlayAppService.SendAsync(new ValueSet
                {
                    ["protocol_version"] = OverlayProtocol.CurrentVersion,
                    ["type"] = "get-overlay-state",
                });
                UpdateOverlayState(response);
            }
            catch (Exception error)
            {
                TargetText.Text = $"Overlay service unavailable: {error.Message}";
            }
            ReadStoredOverlayState();
        }

        private void StateTimerTick(object sender, object args)
        {
            ReadStoredOverlayState();
        }

        private void ReadStoredOverlayState()
        {
            var settings = ApplicationData.Current.LocalSettings.Values;
            var state = new ValueSet();
            foreach (var pair in settings)
            {
                if (pair.Key.StartsWith("overlay.", StringComparison.Ordinal))
                {
                    state[pair.Key.Substring("overlay.".Length)] = pair.Value;
                }
            }
            UpdateOverlayState(state);
        }

        private void UpdateOverlayState(ValueSet state)
        {
            if (state.TryGetValue("target_fps", out var fpsValue) &&
                fpsValue is int fps &&
                (fps == 60 || fps == 90 || fps == 120))
            {
                targetFps = (uint)fps;
            }
            if (state.TryGetValue("model_id", out var modelValue) &&
                modelValue is string modelId &&
                (modelId == "standard" || modelId == "keyboard" || modelId == "gamepad"))
            {
                selectedModelId = modelId;
            }
            overlayEnabled = state.TryGetValue("enabled", out var enabledValue) &&
                enabledValue is bool isEnabled && isEnabled;
            targetActive = state.TryGetValue("active", out var activeValue) &&
                activeValue is bool isActive && isActive;
            ApplyOverlayState();
        }

        private void ApplyOverlayState()
        {
            var gameBarVisible = widget == null || widget.Visible;
            var renderVisible = overlayEnabled && targetActive && gameBarVisible;
            Live2DView.Visibility = renderVisible ? Visibility.Visible : Visibility.Collapsed;
            UpdateStatus();
            if (!live2DReady) return;
            if (lastPostedVisibility != renderVisible)
            {
                lastPostedVisibility = renderVisible;
                PostToLive2D(new JsonObject
                {
                    ["type"] = JsonValue.CreateStringValue("set-visible"),
                    ["visible"] = JsonValue.CreateBooleanValue(renderVisible),
                });
            }
            if (lastPostedTargetFps != targetFps)
            {
                lastPostedTargetFps = targetFps;
                PostToLive2D(new JsonObject
                {
                    ["type"] = JsonValue.CreateStringValue("set-overlay-fps"),
                    ["targetFPS"] = JsonValue.CreateNumberValue(targetFps),
                });
            }
            if (lastPostedModelId != selectedModelId)
            {
                lastPostedModelId = selectedModelId;
                PostToLive2D(new JsonObject
                {
                    ["type"] = JsonValue.CreateStringValue("set-model"),
                    ["modelId"] = JsonValue.CreateStringValue(selectedModelId),
                });
            }
            PostToLive2D(new JsonObject
            {
                ["type"] = JsonValue.CreateStringValue("set-controls-visible"),
                ["controlsVisible"] = JsonValue.CreateBooleanValue(gameBarVisible),
            });
        }

        private void UpdateStatus()
        {
            var gameBarVisible = widget == null || widget.Visible;
            if (overlayEnabled && targetActive && gameBarVisible)
            {
                StatusText.Text = actualFps >= 0
                    ? $"Live2D {actualFps} / {targetFps} FPS"
                    : $"Live2D target: {targetFps} FPS";
            }
            else
            {
                StatusText.Text = overlayEnabled
                    ? "Waiting for the selected game window"
                    : "Enable MochiPaw overlay in the desktop app";
            }
        }

        private void PostToLive2D(JsonObject message)
        {
            if (Live2DView.CoreWebView2 == null) return;
            Live2DView.CoreWebView2.PostWebMessageAsJson(message.Stringify());
        }
    }
}
