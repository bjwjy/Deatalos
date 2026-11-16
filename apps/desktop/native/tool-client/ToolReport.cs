using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace HydraulicTools
{
    // Explicit opt-in local output adapter. Every run owns a new directory; no
    // caller filename, project design, old report or scratch-file cleanup is used.
    internal sealed class ToolReport
    {
        private readonly string directory;
        private readonly List<object> files = new List<object>();

        private ToolReport(string directory) { this.directory = directory; }

        internal static string Publish(ToolConnection connection, string response, bool preview)
        {
            var full = ClientData.Object(response);
            var value = ToolSummary.Map(full, "value");
            string record = null;
            try
            {
                string parent = connection.Directory;
                foreach (string name in new[] { "导出_Exports", "诊断_Diagnostics", "AI接入_AiCalls" }) parent = MakeDirectory(parent, name);
                string leaf = (preview ? "preview-" : "context-") + Guid.NewGuid().ToString("N");
                string candidate = Path.Combine(parent, leaf);
                if (Directory.Exists(candidate) || File.Exists(candidate)) throw new IOException("Report path collision");
                record = MakeDirectory(parent, leaf);
                var report = new ToolReport(record);
                report.Text("response.json", ToolJson.Format(response));
                if (preview)
                {
                    var proposed = ToolSummary.Map(value, "preview");
                    report.Json("changes.json", ToolSummary.Field(proposed, "changes"));
                    report.Json("components.json", ToolSummary.ChangedComponents(value));
                    report.Json("validation.json", new { result = ToolSummary.Field(proposed, "runtimeValidation"), scope = ToolSummary.Field(proposed, "runtimeValidationScope") });
                }
                else
                {
                    var rows = ToolSummary.Rows(ToolSummary.Map(value, "collections"), "catalog");
                    MakeDirectory(record, "catalog");
                    for (int i = 0; i < rows.Length; i++)
                    {
                        report.Json(ToolSummary.CatalogFile(i), rows[i]);
                        report.Text("catalog/" + i.ToString("D4") + ".md", ToolMarkdown.Definition(rows[i]));
                    }
                    report.Json("catalog-index.json", ToolSummary.CatalogIndex(rows));
                    report.Text("catalog.md", ToolMarkdown.Catalog(rows));
                    report.Text("design.md", ToolMarkdown.Design(value));
                    var collections = ToolSummary.Map(value, "collections");
                    if (collections.ContainsKey("diagnostic-batches"))
                    {
                        var status = ToolSummary.Map(ToolSummary.Map(value, "capture"), "diagnosticStatus");
                        report.Text("diagnostics.md", ToolMarkdown.Diagnostics(status, ToolSummary.Rows(collections, "diagnostic-batches")));
                    }
                    report.Json("design.json", ToolSummary.Design(value));
                    MakeDirectory(record, "design");
                    foreach (string name in new[] { "project", "components", "nodes", "connections", "layout", "parameters" })
                        report.Json("design/" + name + ".json", ToolSummary.Field(ToolSummary.Map(value, "collections"), name));
                    report.Json("request-schema.json", ToolSummary.Field(ToolSummary.Map(value, "capabilities"), "requestSchema"));
                    report.Text("commands.md", ToolMarkdown.Commands(ToolSummary.Map(ToolSummary.Map(value, "capabilities"), "requestSchema")));
                    report.Json("preview-template.json", ToolSummary.Field(value, "previewTemplate"));
                }
                string summary = ToolSummary.Fit(ToolSummary.Build(full, connection.ProjectId, connection.Directory, record, preview));
                report.Text("summary.json", summary);
                // A partial directory has no completed manifest. Never delete it or
                // claim success when any required result file could not be written.
                report.Json("manifest.json", new
                {
                    format = "HydraulicToolLocalRecord", version = 1, complete = true,
                    createdAt = DateTime.UtcNow.ToString("o"), projectId = connection.ProjectId,
                    sourceFormat = ToolSummary.Field(full, "format"), files = report.files.ToArray(),
                    purpose = "Local AI interface response, not a simulation result or application diagnostic export batch. No automatic upload or cleanup."
                });
                return summary;
            }
            catch (ClientFailure error) { throw Failed(value, record, preview, error.Code); }
            catch (UnauthorizedAccessException) { throw Failed(value, record, preview, "ACCESS_DENIED"); }
            catch (IOException) { throw Failed(value, record, preview, "IO_FAILED"); }
            catch (ArgumentException) { throw Failed(value, record, preview, "PATH_INVALID"); }
            catch (System.Security.SecurityException) { throw Failed(value, record, preview, "ACCESS_DENIED"); }
        }

        private static string MakeDirectory(string parent, string name)
        {
            ClientData.CheckPath(parent);
            string target = Path.Combine(parent, name);
            if (File.Exists(target)) throw new IOException("Report directory is a file");
            if (!Directory.Exists(target)) Directory.CreateDirectory(target);
            ClientData.CheckPath(target);
            return target;
        }

        private void Json(string name, object value) { Text(name, ToolJson.Format(ClientData.Json.Serialize(value))); }
        private void Text(string name, string value)
        {
            string file = Path.Combine(directory, name.Replace('/', Path.DirectorySeparatorChar));
            ClientData.CheckPath(Path.GetDirectoryName(file));
            byte[] bytes = ClientData.Utf8.GetBytes(value);
            using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            string digest;
            using (var hash = SHA256.Create()) digest = ClientData.Hex(hash.ComputeHash(bytes));
            files.Add(new { path = name, bytes = bytes.Length, sha256 = digest });
        }

        private static WorkflowReplyFailure Failed(Dictionary<string, object> value, string record, bool preview, string cause)
        {
            var result = new Dictionary<string, object>
            {
                { "ok", false }, { "format", "HydraulicToolSummaryFailure" }, { "version", 1 },
                { "recordDirectory", record }, { "causeCode", cause },
                { "diagnostics", new[] { new { code = "REPORT_WRITE_FAILED", field = "/client/report", severity = "error",
                    message = preview ? "候选已提交，摘要或本地记录生成失败；按返回ID查看，不要重复提交。" : "完整读取已完成，但摘要或本地记录生成失败；未提交工程候选。",
                    suggestion = "缺少完整manifest的目录不是已完成记录；保留原件，核对路径/容量/写入权限，不批量清理或修改系统策略。" } } }
            };
            if (preview)
            {
                var proposal = ToolSummary.Map(value, "proposal");
                result.Add("submitted", true);
                result.Add("proposalId", ToolSummary.Field(proposal, "proposalId"));
                result.Add("lastVerifiedState", ToolSummary.Field(proposal, "state"));
            }
            return new WorkflowReplyFailure(ClientData.Json.Serialize(result));
        }
    }
}
