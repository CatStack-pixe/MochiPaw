using System;
using Windows.ApplicationModel.AppService;
using Windows.ApplicationModel.Background;
using Windows.Foundation.Collections;

namespace MochiPaw.GameBarWidget
{
    public sealed class GameBarOverlayService : IBackgroundTask
    {
        private BackgroundTaskDeferral taskDeferral;
        private AppServiceConnection connection;
        private int completed;

        public void Run(IBackgroundTaskInstance taskInstance)
        {
            var details = taskInstance.TriggerDetails as AppServiceTriggerDetails;
            if (details == null)
            {
                return;
            }

            taskDeferral = taskInstance.GetDeferral();
            connection = details.AppServiceConnection;
            taskInstance.Canceled += OnCanceled;
            connection.ServiceClosed += OnServiceClosed;
            connection.RequestReceived += OnRequestReceived;
        }

        private async void OnRequestReceived(AppServiceConnection sender, AppServiceRequestReceivedEventArgs args)
        {
            var requestDeferral = args.GetDeferral();
            try
            {
                var response = OverlayProtocol.Handle(args.Request.Message);
                await args.Request.SendResponseAsync(response);
            }
            catch (Exception error)
            {
                await args.Request.SendResponseAsync(new ValueSet
                {
                    ["protocol_version"] = OverlayProtocol.CurrentVersion,
                    ["accepted"] = false,
                    ["error"] = error.Message,
                });
            }
            finally
            {
                requestDeferral.Complete();
            }
        }

        private void OnServiceClosed(AppServiceConnection sender, AppServiceClosedEventArgs args)
        {
            CompleteTask();
        }

        private void OnCanceled(IBackgroundTaskInstance sender, BackgroundTaskCancellationReason reason)
        {
            CompleteTask();
        }

        private void CompleteTask()
        {
            if (System.Threading.Interlocked.Exchange(ref completed, 1) == 0)
            {
                if (connection != null)
                {
                    connection.RequestReceived -= OnRequestReceived;
                    connection.ServiceClosed -= OnServiceClosed;
                }
                taskDeferral?.Complete();
            }
        }
    }
}
