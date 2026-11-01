using System;
using Windows.ApplicationModel.AppService;
using Windows.Foundation.Collections;

namespace MochiPaw.GameBarWidget
{
    internal static class OverlayAppService
    {
        public static async System.Threading.Tasks.Task<ValueSet> SendAsync(ValueSet values)
        {
            var connection = new AppServiceConnection
            {
                AppServiceName = "com.catstack.mochipaw.overlay",
                PackageFamilyName = Windows.ApplicationModel.Package.Current.Id.FamilyName,
            };

            try
            {
                var status = await connection.OpenAsync();
                if (status != AppServiceConnectionStatus.Success)
                {
                    throw new InvalidOperationException($"AppService connection failed: {status}");
                }

                var response = await connection.SendMessageAsync(values);
                if (response.Status != AppServiceResponseStatus.Success)
                {
                    throw new InvalidOperationException($"AppService message failed: {response.Status}");
                }

                var message = response.Message;
                if (!message.TryGetValue("protocol_version", out var rawProtocolVersion) ||
                    !(rawProtocolVersion is int protocolVersion) ||
                    protocolVersion != OverlayProtocol.CurrentVersion)
                {
                    throw new InvalidOperationException("The Game Bar service returned an unsupported protocol version.");
                }

                if (!message.TryGetValue("accepted", out var rawAccepted) ||
                    !(rawAccepted is bool accepted) || !accepted)
                {
                    var error = message.TryGetValue("error", out var rawError) ? rawError as string : null;
                    throw new InvalidOperationException(error ?? "The Game Bar service rejected the request.");
                }

                return message;
            }
            finally
            {
                connection.Dispose();
            }
        }
    }
}
