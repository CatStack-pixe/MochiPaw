using System;
using System.Collections.Generic;
using Windows.Foundation.Collections;
using Windows.Storage;

namespace MochiPaw.GameBarWidget
{
    internal static class OverlayProtocol
    {
        public const int CurrentVersion = 1;
        private const string Prefix = "overlay.";
        private static readonly object Gate = new object();

        public static ValueSet Handle(ValueSet request)
        {
            if (request == null) return Error(null, "request is missing");
            if (!request.TryGetValue("protocol_version", out var rawVersion) ||
                !(rawVersion is int version) ||
                version != CurrentVersion)
            {
                return Error(ReadString(request, "type"), "unsupported protocol_version");
            }

            var type = ReadString(request, "type");
            if (String.IsNullOrWhiteSpace(type)) return Error(null, "type is required");

            lock (Gate)
            {
                var settings = ApplicationData.Current.LocalSettings.Values;
                switch (type)
                {
                    case "set-overlay-fps":
                        if (!request.TryGetValue("target_fps", out var rawFps) ||
                            !(rawFps is int fps) ||
                            (fps != 60 && fps != 90 && fps != 120))
                        {
                            return Error(type, "target_fps must be 60, 90, or 120");
                        }
                        settings[Key("target_fps")] = fps;
                        break;

                    case "set-overlay-session":
                        if (!request.TryGetValue("enabled", out var enabledValue) ||
                            !(enabledValue is bool enabled))
                        {
                            return Error(type, "enabled must be a boolean");
                        }
                        if (!request.TryGetValue("target_fps", out var targetValue) ||
                            !(targetValue is int targetFps) ||
                            (targetFps != 60 && targetFps != 90 && targetFps != 120))
                        {
                            return Error(type, "target_fps must be 60, 90, or 120");
                        }
                        settings[Key("enabled")] = enabled;
                        settings[Key("target_fps")] = targetFps;
                        if (request.TryGetValue("pass_through", out var sessionPassThroughValue))
                        {
                            if (!(sessionPassThroughValue is bool sessionPassThrough))
                            {
                                return Error(type, "pass_through must be a boolean");
                            }
                            settings[Key("pass_through")] = sessionPassThrough;
                        }
                        if (request.TryGetValue("model_id", out var sessionModelValue))
                        {
                            if (!(sessionModelValue is string sessionModelId))
                            {
                                return Error(type, "model_id must be a string");
                            }
                            settings[Key("model_id")] = sessionModelId;
                        }
                        break;

                    case "set-overlay-state":
                        if (!request.TryGetValue("active", out var activeValue) ||
                            !(activeValue is bool active))
                        {
                            return Error(type, "active must be a boolean");
                        }
                        settings[Key("active")] = active;
                        if (request.TryGetValue("enabled", out var stateEnabledValue))
                        {
                            if (!(stateEnabledValue is bool stateEnabled))
                            {
                                return Error(type, "enabled must be a boolean");
                            }
                            settings[Key("enabled")] = stateEnabled;
                        }
                        if (request.TryGetValue("target_fps", out var stateFpsValue))
                        {
                            if (!(stateFpsValue is int stateFps) ||
                                (stateFps != 60 && stateFps != 90 && stateFps != 120))
                            {
                                return Error(type, "target_fps must be 60, 90, or 120");
                            }
                            settings[Key("target_fps")] = stateFps;
                        }
                        if (request.TryGetValue("pass_through", out var passThroughValue))
                        {
                            if (!(passThroughValue is bool passThrough))
                            {
                                return Error(type, "pass_through must be a boolean");
                            }
                            settings[Key("pass_through")] = passThrough;
                        }
                        if (request.TryGetValue("model_id", out var modelValue))
                        {
                            if (!(modelValue is string modelId))
                            {
                                return Error(type, "model_id must be a string");
                            }
                            settings[Key("model_id")] = modelId;
                        }
                        foreach (var field in new[]
                        {
                            "process_name", "process_id", "window_handle", "x", "y",
                            "width", "height", "dpi_scale", "minimized", "model_id",
                        })
                        {
                            CopyIfPresent(request, settings, field);
                        }
                        break;

                    case "get-overlay-state":
                        break;

                    default:
                        return Error(type, "unknown message type");
                }

                return Snapshot(type, settings);
            }
        }

        public static ValueSet ReadStoredState()
        {
            lock (Gate)
            {
                return Snapshot("widget-state", ApplicationData.Current.LocalSettings.Values);
            }
        }

        private static ValueSet Snapshot(string type, IDictionary<string, object> settings)
        {
            return new ValueSet
            {
                ["protocol_version"] = CurrentVersion,
                ["accepted"] = true,
                ["type"] = type,
                ["enabled"] = ReadBool(settings, "enabled", false),
                ["active"] = ReadBool(settings, "active", false),
                ["visible"] = ReadBool(settings, "visible", false),
                ["target_fps"] = ReadInt(settings, "target_fps", 60),
                ["click_through"] = ReadBool(settings, "pass_through", true),
                ["process_name"] = ReadString(settings, "process_name") ?? String.Empty,
                ["process_id"] = ReadInt(settings, "process_id", 0),
                ["window_handle"] = ReadInt64(settings, "window_handle", 0),
                ["x"] = ReadInt(settings, "x", 0),
                ["y"] = ReadInt(settings, "y", 0),
                ["width"] = ReadInt(settings, "width", 0),
                ["height"] = ReadInt(settings, "height", 0),
                ["dpi_scale"] = ReadDouble(settings, "dpi_scale", 1.0),
                ["minimized"] = ReadBool(settings, "minimized", false),
                ["model_id"] = ReadString(settings, "model_id") ?? String.Empty,
            };
        }

        private static void CopyIfPresent(ValueSet request, IDictionary<string, object> settings, string field)
        {
            if (request.TryGetValue(field, out var value) && value != null)
            {
                settings[Key(field)] = value;
            }
        }

        private static string Key(string field) => Prefix + field;

        private static int ReadInt(IDictionary<string, object> settings, string field, int fallback)
        {
            return settings.TryGetValue(Key(field), out var value) && value is int number ? number : fallback;
        }

        private static long ReadInt64(IDictionary<string, object> settings, string field, long fallback)
        {
            if (!settings.TryGetValue(Key(field), out var value)) return fallback;
            if (value is long longNumber) return longNumber;
            return value is int intNumber ? intNumber : fallback;
        }

        private static double ReadDouble(IDictionary<string, object> settings, string field, double fallback)
        {
            if (!settings.TryGetValue(Key(field), out var value)) return fallback;
            if (value is double doubleNumber) return doubleNumber;
            return value is int intNumber ? intNumber : fallback;
        }

        private static bool ReadBool(IDictionary<string, object> settings, string field, bool fallback)
        {
            return settings.TryGetValue(Key(field), out var value) && value is bool flag ? flag : fallback;
        }

        private static string ReadString(IDictionary<string, object> settings, string field)
        {
            return settings.TryGetValue(Key(field), out var value) ? value as string : null;
        }

        private static string ReadString(ValueSet values, string field)
        {
            return values.TryGetValue(field, out var value) ? value as string : null;
        }

        private static ValueSet Error(string type, string error)
        {
            var response = new ValueSet
            {
                ["protocol_version"] = CurrentVersion,
                ["accepted"] = false,
                ["error"] = error,
            };
            if (!String.IsNullOrWhiteSpace(type)) response["type"] = type;
            return response;
        }
    }
}
