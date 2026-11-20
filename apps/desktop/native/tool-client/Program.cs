using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace HydraulicTools
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            Console.InputEncoding = ClientData.Utf8;
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                if (args.Length == 1 && args[0] == "--protect")
                {
                    string token = ClientData.ReadStream(Console.OpenStandardInput(), 64);
                    ClientData.Regular(token, @"\A[a-f0-9]{64}\z");
                    byte[] plain = Encoding.Unicode.GetBytes(token);
                    try { Console.Write(ClientData.Hex(ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser))); }
                    finally { Array.Clear(plain, 0, plain.Length); }
                    return 0;
                }
                string project = null;
                string directory = Environment.GetEnvironmentVariable("HYD_TOOLS_CONNECTION_DIR");
                bool diagnose = false;
                bool session = false;
                bool context = false;
                bool summary = false;
                bool compare = false;
                string[] cylinders = null;
                long? fromTick = null;
                string previewFile = null;
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--project" && project == null && i + 1 < args.Length) project = args[++i];
                    else if (args[i] == "--connection-dir" && i + 1 < args.Length) directory = args[++i];
                    else if (args[i] == "--diagnose" && !diagnose) diagnose = true;
                    else if (args[i] == "--session" && !session) session = true;
                    else if (args[i] == "--context" && !context) context = true;
                    else if (args[i] == "--compare-cylinders" && !compare) compare = true;
                    else if (args[i] == "--cylinders" && cylinders == null && i + 2 < args.Length)
                        cylinders = new[] { args[++i], args[++i] };
                    else if (args[i] == "--from-tick" && !fromTick.HasValue && i + 1 < args.Length)
                    {
                        long tick;
                        if (!Int64.TryParse(args[++i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out tick) || tick > 9007199254740991L)
                            throw ClientData.Fail("ARGUMENT_INVALID", "起始步须为非负安全整数。", "例如 --from-tick 80。");
                        fromTick = tick;
                    }
                    else if (args[i] == "--summary" && !summary) summary = true;
                    else if (args[i] == "--preview-file" && previewFile == null && i + 1 < args.Length) previewFile = args[++i];
                    else throw ClientData.Fail("ARGUMENT_INVALID", "客户端参数无效。", "使用 --project 绝对工程目录，JSON请求从stdin输入。");
                }
                if (project == null)
                    for (var current = new DirectoryInfo(Environment.CurrentDirectory); current != null; current = current.Parent)
                        if (File.Exists(Path.Combine(current.FullName, "工程.hydproj"))) { project = current.FullName; break; }
                if (project == null) throw ClientData.Fail("PROJECT_REQUIRED", "未定位到文件夹工程。", "指定 --project 绝对目录；不要猜测其他打开的工程。");
                if ((diagnose ? 1 : 0) + (session ? 1 : 0) + (context ? 1 : 0) + (previewFile != null ? 1 : 0) + (compare ? 1 : 0) > 1)
                    throw ClientData.Fail("ARGUMENT_INVALID", "诊断、持续连接、上下文、双缸比较和文件预览各自独立。", "每次选择一种模式。");
                if (summary && !context && previewFile == null)
                    throw ClientData.Fail("ARGUMENT_INVALID", "摘要模式仅用于上下文读取或文件预览。", "使用 --context --summary 或 --preview-file <JSON绝对路径> --summary。");
                if (!compare && (cylinders != null || fromTick.HasValue))
                    throw ClientData.Fail("ARGUMENT_INVALID", "缸选择及起始步仅用于双缸比较。", "使用 --compare-cylinders。");
                var connection = new ToolConnection(project, String.IsNullOrEmpty(directory) ? null : directory);
                if (compare)
                {
                    var parameters = new Dictionary<string, object>();
                    if (cylinders != null) parameters.Add("cylinderIds", cylinders);
                    if (fromTick.HasValue) parameters.Add("fromTick", fromTick.Value);
                    return Send(connection, ClientData.Json.Serialize(new { protocol = "HydraulicTools", version = 1, requestId = "cmp-" + Guid.NewGuid().ToString("N"), method = "cylinder_compare", @params = parameters }));
                }
                if (context || previewFile != null)
                {
                    var workflow = new ToolWorkflow(connection);
                    return workflow.Run(previewFile, summary);
                }
                if (session)
                {
                    if (diagnose) throw ClientData.Fail("ARGUMENT_INVALID", "持续连接与单次诊断不能同时使用。", "持续连接第一行发送capabilities请求。");
                    using (var reader = new StreamReader(Console.OpenStandardInput(), ClientData.Utf8, false, 8192))
                    {
                        int last = 0;
                        for (int i = 0; i < 128; i++)
                        {
                            string frame = ClientData.ReadLine(reader);
                            if (frame == null) return last;
                            last = Send(connection, frame);
                            Console.Out.Flush();
                        }
                    }
                    throw ClientData.Fail("SESSION_LIMIT", "持续连接已达128次请求上限。", "结束当前进程，重新核对工程后连接。");
                }
                string input = diagnose
                    ? ClientData.Json.Serialize(new { protocol = "HydraulicTools", version = 1, requestId = "diag-" + Guid.NewGuid().ToString("N"), method = "capabilities", @params = new { } })
                    : ClientData.ReadStream(Console.OpenStandardInput(), 1048576);
                return Send(connection, input);
            }
            catch (WorkflowReplyFailure error) { Console.WriteLine(error.Output); return 1; }
            catch (ClientFailure error) { return Failure(error.Code, error.Message, error.Suggestion); }
            catch (FileNotFoundException) { return Failure("CONNECTION_FILE_MISSING", "工程入口或连接记录不存在。", "核对工程目录与目标工作台；不能据此断定AI开关未开。"); }
            catch (DirectoryNotFoundException) { return Failure("CONNECTION_DIRECTORY_MISSING", "工程或发现目录不存在。", "核对开发版/安装版的实际连接入口。"); }
            catch (UnauthorizedAccessException) { return Failure("ACCESS_DENIED", "当前进程不能读取所需文件。", "核对AI客户端授权范围与Windows账户，不自动提升权限。"); }
            catch (DecoderFallbackException) { return Failure("UTF8_INVALID", "数据不是有效UTF-8。", "以UTF-8发送JSON请求。"); }
            catch (WebException) { return Failure("ENDPOINT_UNREACHABLE", "本机连接未完成。", "核对目标工作台和AI客户端网络权限。"); }
            catch (IOException) { return Failure("IO_FAILED", "本机读写未完成。", "保留工程，核对目录/文件占用后重试。"); }
            catch (ArgumentException) { return Failure("INPUT_INVALID", "路径或协议输入无效。", "按工程配套说明和capabilities重试。"); }
            catch (Exception) { return Failure("CLIENT_FAILED", "客户端未能完成请求。", "保留工程并记录诊断码；未确认工程修改。"); }
        }

        // One authenticated target per process; business requests cannot retarget this connection.
        private static int Send(ToolConnection connection, string input)
        {
            var reply = Exchange(connection, input);
            Console.WriteLine(reply.Output);
            return reply.Success ? 0 : 1;
        }

        internal static ClientReply Exchange(ToolConnection connection, string input)
        {
            var request = ClientData.Object(input);
            ClientData.Regular(ClientData.Text(request, "requestId"), @"\A[-\w]{1,40}\z");
            var transport = (HttpWebRequest)WebRequest.Create(connection.Endpoint);
            transport.Proxy = null;
            transport.AllowAutoRedirect = false;
            transport.Method = "POST";
            transport.ContentType = "application/json; charset=utf-8";
            transport.Timeout = 12000;
            transport.ReadWriteTimeout = 12000;
            transport.Headers["Authorization"] = "Bearer " + connection.Token;
            // The server validates this against the owning file session before dispatch.
            transport.Headers["X-Hydraulic-Target"] = Convert.ToBase64String(ClientData.Utf8.GetBytes(ClientData.Json.Serialize(new { directory = connection.Directory, projectId = connection.ProjectId, connectionId = connection.ConnectionId })));
            byte[] bytes = ClientData.Utf8.GetBytes(input);
            transport.ContentLength = bytes.Length;
            using (var stream = transport.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            HttpWebResponse response;
            try { response = (HttpWebResponse)transport.GetResponse(); }
            catch (WebException error)
            {
                response = error.Response as HttpWebResponse;
                if (response == null) throw ClientData.Fail(error.Status == WebExceptionStatus.Timeout ? "CONNECTION_TIMEOUT" : "ENDPOINT_UNREACHABLE", "无法连接当前工作台，未向其他实例重发。", "确认工作台仍在运行并已开启AI；沙箱/网络限制需由AI客户端处理。");
            }
            using (response)
            {
                if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) throw ClientData.Fail("REDIRECT_DENIED", "本机接口重定向被拒绝。", "重新开启目标工作台AI。");
                if (response.StatusCode == HttpStatusCode.Unauthorized) throw ClientData.Fail("AUTH_FAILED", "本次连接鉴权已失效。", "重开目标工作台AI，不复用旧令牌。");
                string output;
                using (var stream = response.GetResponseStream()) output = ClientData.ReadStream(stream, 4194304);
                var reply = ClientData.Object(output);
                object ok;
                bool success = reply.TryGetValue("ok", out ok) && ok is bool && (bool)ok;
                // Reject old servers lacking target verification, even for a successful HTTP request.
                if (success && response.Headers["X-Hydraulic-Connection"] != connection.ConnectionId)
                    throw ClientData.Fail("TARGET_UNVERIFIED", "工作台未提供目标工程核对能力。", "使用当前源码工作台；旧安装版仅能用原兼容客户端并人工核对。");
                if (success && (ClientData.Text(reply, "requestId") != ClientData.Text(request, "requestId") || ClientData.Text(reply, "protocol") != "HydraulicTools" || !ClientData.VersionOne(reply)))
                    throw ClientData.Fail("RESPONSE_MISMATCH", "响应身份与请求不一致。", "重新捕获当前工程，不应用旧候选。");
                if (output.Contains(connection.Token)) throw ClientData.Fail("SECRET_RESPONSE_DENIED", "响应含不应公开的凭证，未输出。", "检查工具响应，不向聊天提供令牌。");
                return new ClientReply(output, reply, success && response.StatusCode == HttpStatusCode.OK);
            }
        }

        private static int Failure(string code, string message, string suggestion)
        {
            Console.Error.WriteLine(ClientData.Json.Serialize(new { ok = false, diagnostics = new[] { new { code = code, field = "/client", severity = "error", message = message, suggestion = suggestion } } }));
            return 1;
        }
    }
}
