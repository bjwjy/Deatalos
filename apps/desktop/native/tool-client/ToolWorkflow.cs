using System;
using System.Collections.Generic;
using System.IO;
using System.Net;

namespace HydraulicTools
{
    internal sealed class ClientReply
    {
        internal readonly string Output;
        internal readonly Dictionary<string, object> Envelope;
        internal readonly bool Success;

        internal ClientReply(string output, Dictionary<string, object> envelope, bool success)
        {
            Output = output;
            Envelope = envelope;
            Success = success;
        }
    }

    // Preserve the original protocol diagnostics instead of replacing a stale/retired
    // response with partial context or silently retrying against a fresh base.
    internal sealed class WorkflowReplyFailure : Exception
    {
        internal readonly string Output;
        internal WorkflowReplyFailure(string output) { Output = output; }
    }

    /** Fixed read/propose sequences only. Optional local reports are owned by
     * ToolReport; no script evaluation, apply, automatic retry or engineering owner. */
    internal sealed class ToolWorkflow
    {
        private readonly ToolConnection connection;
        private int requests;
        private int bytes;

        internal ToolWorkflow(ToolConnection connection) { this.connection = connection; }

        internal int Run(string previewFile, bool summary)
        {
            object value = previewFile == null ? Context(summary) : Preview(previewFile);
            string output = ClientData.Json.Serialize(new
            {
                ok = true,
                format = previewFile == null ? "HydraulicToolContext" : "HydraulicToolPreview",
                version = 1,
                requestCount = requests,
                value = value
            });
            if (ClientData.Utf8.GetByteCount(output) > 4194304) throw Capacity();
            if (summary) output = ToolReport.Publish(connection, output, previewFile != null);
            Console.WriteLine(output);
            return 0;
        }

        private Dictionary<string, object> Call(string method, object parameters)
        {
            if (++requests > 128) throw Capacity();
            string input = ClientData.Json.Serialize(new
            {
                protocol = "HydraulicTools", version = 1,
                requestId = "fixed-" + requests, method = method, @params = parameters
            });
            if (ClientData.Utf8.GetByteCount(input) > 1048576) throw Capacity();
            var reply = Program.Exchange(connection, input);
            if (!reply.Success) throw new WorkflowReplyFailure(reply.Output);
            bytes += ClientData.Utf8.GetByteCount(reply.Output);
            if (bytes > 4194304) throw Capacity();
            return ObjectField(reply.Envelope, "value");
        }

        private object Context(bool summary)
        {
            var capabilities = Call("capabilities", new { });
            int pageSize = Integer(ObjectField(capabilities, "limits"), "page");
            if (pageSize < 1 || pageSize > 20) throw Shape();
            var capture = Call("capture", new { });
            string id = ClientData.Text(capture, "captureId");
            var anchor = ObjectField(capture, "base");
            var collections = new Dictionary<string, object>();
            var names = new List<string> { "project", "catalog", "components", "nodes", "connections", "layout", "parameters" };
            if (summary && capture.ContainsKey("diagnosticStatus")) names.Add("diagnostic-batches");
            foreach (string name in names)
            {
                var items = new List<object>();
                int offset = 0;
                int total = -1;
                while (true)
                {
                    var page = Call("read", new { captureId = id, collection = name, offset = offset, limit = pageSize, simulationSessionId = (string)null });
                    if (ClientData.Text(page, "captureId") != id || ClientData.Text(page, "collection") != name ||
                        !Same(ObjectField(page, "base"), anchor) || Integer(page, "offset") != offset) throw Shape();
                    int count = Integer(page, "count");
                    if (count < 0 || (total >= 0 && total != count)) throw Shape();
                    total = count;
                    object raw;
                    var rows = page.TryGetValue("items", out raw) ? raw as object[] : null;
                    if (rows == null || rows.Length != Math.Min(pageSize, total - offset)) throw Shape();
                    items.AddRange(rows);
                    int end = offset + rows.Length;
                    if (!page.TryGetValue("nextOffset", out raw)) throw Shape();
                    if (raw == null)
                    {
                        if (end != total) throw Shape();
                        break;
                    }
                    if (!(raw is int) || (int)raw != end || end <= offset || end >= total || end > 2000) throw Shape();
                    offset = end;
                }
                collections.Add(name, new { count = total, items = items });
            }
            return new
            {
                capabilities = capabilities, capture = capture, collections = collections,
                previewTemplate = new { @base = anchor, operation = "edit", commands = new object[0] }
            };
        }

        private object Preview(string file)
        {
            // The JSON file is an ordinary bounded input, never executable content.
            // Require the caller's captured base; never replace it with a new base.
            if (!Path.IsPathRooted(file) || file.StartsWith(@"\\", StringComparison.Ordinal))
                throw ClientData.Fail("PATH_INVALID", "预览文件须为本机绝对路径。", "把预览params保存为UTF-8 JSON，传入绝对文件路径。");
            var parameters = ClientData.Object(ClientData.Read(Path.GetFullPath(file), 1048576));
            ClientData.Keys(parameters, "base", "operation", "commands");
            ObjectField(parameters, "base");
            object commands;
            var rows = parameters.TryGetValue("commands", out commands) ? commands as object[] : null;
            if (rows == null || rows.Length > 30) throw Shape();
            string operation = ClientData.Text(parameters, "operation");
            if (operation != "edit" && operation != "undo" && operation != "redo") throw Shape();
            var preview = Call("preview", parameters);
            string id = ClientData.Text(preview, "proposalId");
            try
            {
                if (!Same(ObjectField(parameters, "base"), ObjectField(preview, "base"))) throw Shape();
                var proposal = Call("proposal", new { proposalId = id });
                if (ClientData.Text(proposal, "proposalId") != id || !Same(ObjectField(preview, "base"), ObjectField(proposal, "base"))) throw Shape();
                // Return the actual state, including a concurrent user acceptance or retirement.
                return new { preview = preview, proposal = proposal };
            }
            catch (WorkflowReplyFailure error) { throw CheckFailed(id, ClientData.Object(error.Output)); }
            catch (ClientFailure error) { throw CheckFailed(id, new { code = error.Code, message = error.Message }); }
            catch (WebException) { throw CheckFailed(id, new { code = "ENDPOINT_UNREACHABLE" }); }
            catch (IOException) { throw CheckFailed(id, new { code = "IO_FAILED" }); }
        }

        private static WorkflowReplyFailure CheckFailed(string id, object cause)
        {
            return new WorkflowReplyFailure(ClientData.Json.Serialize(new
            {
                ok = false, format = "HydraulicToolPreview", version = 1,
                submitted = true, proposalId = id,
                diagnostics = new[] { new { code = "PROPOSAL_CHECK_FAILED", field = "/proposal", severity = "error",
                    message = "候选已提交，但状态核对失败；先按proposalId查询或在工作台查看，不要重复提交。" } },
                cause = cause
            }));
        }

        private static Dictionary<string, object> ObjectField(Dictionary<string, object> source, string key)
        {
            object value;
            var result = source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
            if (result == null) throw Shape();
            return result;
        }

        private static int Integer(Dictionary<string, object> source, string key)
        {
            object value;
            if (!source.TryGetValue(key, out value) || !(value is int)) throw Shape();
            return (int)value;
        }

        private static bool Same(object left, object right)
        {
            var a = left as Dictionary<string, object>;
            var b = right as Dictionary<string, object>;
            if (a == null || b == null) return Object.Equals(left, right);
            if (a.Count != b.Count) return false;
            foreach (var pair in a)
            {
                object value;
                if (!b.TryGetValue(pair.Key, out value) || !Same(pair.Value, value)) return false;
            }
            return true;
        }

        private static ClientFailure Shape()
        {
            return ClientData.Fail("WORKFLOW_SHAPE_INVALID", "固定流程的数据结构、身份或分页不完整。", "检查当前版本协议；未输出部分上下文，也不自动重新捕获或提交。");
        }

        private static ClientFailure Capacity()
        {
            return ClientData.Fail("WORKFLOW_LIMIT", "固定流程超过请求数或数据容量。", "改用原始read显式分页；不能把部分数据当成完整工程。");
        }
    }
}
