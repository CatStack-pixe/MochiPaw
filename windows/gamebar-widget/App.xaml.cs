using Microsoft.Gaming.XboxGameBar;
using System;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace MochiPaw.GameBarWidget
{
    sealed partial class App : Application
    {
        private XboxGameBarWidget widget;

        public App()
        {
            InitializeComponent();
            Suspending += OnSuspending;
        }

        protected override async void OnActivated(IActivatedEventArgs args)
        {
            if (args.Kind != ActivationKind.Protocol ||
                !(args is IProtocolActivatedEventArgs protocolArgs) ||
                !protocolArgs.Uri.Scheme.Equals("ms-gamebarwidget", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var widgetArgs = args as XboxGameBarWidgetActivatedEventArgs;
            if (widgetArgs == null || !widgetArgs.IsLaunchActivation ||
                widgetArgs.AppExtensionId != "MochiPawOverlay")
            {
                return;
            }

            try
            {
                await FullTrustProcessLauncher.LaunchFullTrustProcessForCurrentAppAsync("OverlayBridge");
            }
            catch
            {
                // The widget remains usable for local Live2D controls even when
                // the packaged bridge has not been installed or launched.
            }

            var rootFrame = new Frame();
            Window.Current.Content = rootFrame;
            widget = new XboxGameBarWidget(widgetArgs, Window.Current.CoreWindow, rootFrame);
            rootFrame.Navigate(typeof(MainPage), widget);
            Window.Current.Closed += OnWidgetClosed;
            Window.Current.Activate();
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            var rootFrame = Window.Current.Content as Frame ?? new Frame();
            Window.Current.Content = rootFrame;
            if (rootFrame.Content == null)
            {
                rootFrame.Navigate(typeof(MainPage));
            }
            Window.Current.Activate();
        }

        private void OnWidgetClosed(object sender, CoreWindowEventArgs args)
        {
            widget = null;
            Window.Current.Closed -= OnWidgetClosed;
        }

        private void OnSuspending(object sender, SuspendingEventArgs args)
        {
        }
    }
}
