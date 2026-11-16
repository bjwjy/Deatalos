using System;
using System.Collections.Generic;

namespace HydraulicTools
{
    // Pure projections of checked public responses. The full response remains the
    // source; summary omissions are explicit file references, never invented zeros.
    internal static class ToolSummary
    {
        internal const int MaximumBytes = 8192;
        internal static string CatalogFile(int index) { return "catalog/" + index.ToString("D4") + ".json"; }

        internal static Dictionary<string, object> Build(Dictionary<string, object> full, string project,
            string directory, string recordDirectory, bool preview)
        {
            var value = Map(full, "value");
            var summary = new Dictionary<string, object>
            {
                { "ok", true }, { "version", 1 },
                { "format", preview ? "HydraulicToolPreviewSummary" : "HydraulicToolContextSummary" },
                { "requestCount", Field(full, "requestCount") },
                { "projectId", project }, { "projectDirectory", directory },
                { "recordDirectory", recordDirectory },
                { "fullResponseFile", "response.json" }, { "manifestFile", "manifest.json" },
                { "readDetails", "Resolve these relative files under recordDirectory. Read them with built-in file tools; do not rerun the client or launch a shell just to parse saved JSON." }
            };
            if (preview) Preview(summary, value);
            else Context(summary, value);
            return summary;
        }

        private static void Context(Dictionary<string, object> summary, Dictionary<string, object> value)
        {
            var collections = Map(value, "collections");
            var counts = new Dictionary<string, object>();
            foreach (var pair in collections) counts.Add(pair.Key, Field(AsMap(pair.Value), "count"));
            summary.Add("capture", Field(value, "capture"));
            summary.Add("counts", counts);
            summary.Add("previewTemplate", Field(value, "previewTemplate"));
            summary.Add("previewTemplateFile", "preview-template.json");
            summary.Add("requestSchemaFile", "request-schema.json");
            summary.Add("commandGuideFile", "commands.md");
            summary.Add("catalogGuideFile", "catalog.md");
            summary.Add("designGuideFile", "design.md");
            if (collections.ContainsKey("diagnostic-batches"))
                summary.Add("diagnosticGuideFile", "diagnostics.md");
            summary.Add("diagnoseRequired", false);
            summary.Add("catalog", Section(CatalogIndex(Rows(collections, "catalog")), "catalog-index.json"));
            var design = Design(value);
            var sectionFiles = new Dictionary<string, object>();
            foreach (string name in new[] { "project", "components", "nodes", "connections", "layout", "parameters" })
                sectionFiles.Add(name, "design/" + name + ".json");
            summary.Add("design", new Dictionary<string, object> { { "inline", design }, { "completeInline", true }, { "file", "design.json" }, { "sectionFiles", sectionFiles } });
            summary.Add("next", "Capabilities were already fetched. Use designGuideFile and catalogGuideFile for readable design/selection notes. Read commandGuideFile or requestSchemaFile under recordDirectory with a built-in file tool for command fields such as add-component, connect and parameter; do not run --diagnose or another capabilities call merely to learn their format. Read diagnosticGuideFile for workbench error batches when present. Use --diagnose for connection troubleshooting. Inspect existing design and capture.pendingProposals first; do not add a duplicate branch merely to create a proposal. Edit previewTemplate commands with a built-in file tool; keep its base unchanged. Submit once with --preview-file <absolute JSON path> --summary. A stale base requires rereading and reviewing the plan.");
        }

        private static void Preview(Dictionary<string, object> summary, Dictionary<string, object> value)
        {
            var preview = Map(value, "preview");
            var proposal = Map(value, "proposal");
            var validation = Map(preview, "runtimeValidation");
            object valid = Field(validation, "ok");
            if (!(valid is bool)) throw Shape();
            var diagnostics = (bool)valid ? new object[0] : ArrayField(validation, "diagnostics");
            summary.Add("proposalId", Field(proposal, "proposalId"));
            summary.Add("state", Field(proposal, "state"));
            summary.Add("base", Field(proposal, "base"));
            summary.Add("category", Field(preview, "category"));
            summary.Add("physical", Field(preview, "physical"));
            summary.Add("confirmationRequired", Field(preview, "confirmationRequired"));
            summary.Add("validation", new { ok = valid, scope = Field(preview, "runtimeValidationScope"), diagnosticCount = diagnostics.Length, file = "validation.json" });
            summary.Add("delivery", new { status = (bool)valid ? "pending-user-review" : "incomplete-draft",
                requirementsVerified = false, layoutVerified = false, simulationPerformed = false });
            summary.Add("validationDiagnostics", Section(diagnostics, "validation.json"));
            var changes = ArrayField(preview, "changes");
            var index = new List<object>();
            foreach (object row in changes)
            {
                var change = AsMap(row);
                index.Add(new { section = Field(change, "section"), id = Field(change, "id"),
                    action = Field(change, "before") == null ? "add" : Field(change, "after") == null ? "remove" : "update" });
            }
            summary.Add("changeCount", changes.Length);
            summary.Add("commandCount", ArrayField(preview, "commands").Length);
            summary.Add("changes", Section(index.ToArray(), "changes.json"));
            summary.Add("components", Section(ChangedComponents(value), "components.json"));
            summary.Add("next", "Report the actual state and delivery.status above. Failed validation means incomplete-draft, not a completed runnable circuit; describe diagnostics and do not request acceptance merely to split a task. pending means waiting for workbench confirmation, not applied. Validation is static mapping only, not a simulation. This call already queried proposal state; use built-in file tools for details, without a new shell or duplicate submission.");
        }

        internal static object[] CatalogIndex(object[] rows)
        {
            var index = new List<object>();
            for (int i = 0; i < rows.Length; i++)
            {
                var definition = Map(AsMap(rows[i]), "definition");
                var ports = new List<object>();
                foreach (object port in ArrayField(definition, "ports")) ports.Add(Field(AsMap(port), "id"));
                index.Add(new { id = Field(definition, "id"), version = Field(definition, "version"),
                    typeId = Field(definition, "typeId"), ports = ports, file = CatalogFile(i) });
            }
            return index.ToArray();
        }

        internal static object Design(Dictionary<string, object> value)
        {
            var result = new Dictionary<string, object>();
            var collections = Map(value, "collections");
            foreach (var pair in collections) if (pair.Key != "catalog") result.Add(pair.Key, pair.Value);
            return result;
        }

        internal static object[] ChangedComponents(Dictionary<string, object> value)
        {
            var components = new List<object>();
            foreach (object row in ArrayField(Map(value, "preview"), "changes"))
            {
                var change = AsMap(row);
                object after = Field(change, "after");
                if (ClientData.Text(change, "section") == "components" && after != null) components.Add(after);
            }
            return components.ToArray();
        }

        private static Dictionary<string, object> Section(object[] rows, string file)
        {
            return new Dictionary<string, object> { { "count", rows.Length }, { "items", rows }, { "completeInline", true }, { "file", file } };
        }

        internal static string Fit(Dictionary<string, object> summary)
        {
            // Drop complete optional sections, not arbitrary rows or characters.
            // Their counts and detail paths remain available in the same response.
            foreach (string key in new[] { "design", "components", "changes", "catalog", "validationDiagnostics" })
            {
                string text = ToolJson.Format(ClientData.Json.Serialize(summary));
                if (ClientData.Utf8.GetByteCount(text) <= MaximumBytes) return text;
                object raw;
                if (!summary.TryGetValue(key, out raw)) continue;
                var section = AsMap(raw);
                section.Remove("items");
                section.Remove("inline");
                section["completeInline"] = false;
            }
            string minimal = ToolJson.Format(ClientData.Json.Serialize(summary));
            if (ClientData.Utf8.GetByteCount(minimal) > MaximumBytes)
                throw ClientData.Fail("SUMMARY_LIMIT", "摘要身份字段超过8KiB，完整记录已保留。", "使用文件工具读取本次记录，不重跑预览。");
            return minimal;
        }

        internal static object Field(Dictionary<string, object> source, string key)
        {
            object value;
            if (!source.TryGetValue(key, out value)) throw Shape();
            return value;
        }
        internal static Dictionary<string, object> AsMap(object value)
        {
            var result = value as Dictionary<string, object>;
            if (result == null) throw Shape();
            return result;
        }
        internal static Dictionary<string, object> Map(Dictionary<string, object> source, string key) { return AsMap(Field(source, key)); }
        internal static object[] ArrayField(Dictionary<string, object> source, string key)
        {
            var result = Field(source, key) as object[];
            if (result == null) throw Shape();
            return result;
        }
        internal static object[] Rows(Dictionary<string, object> collections, string key) { return ArrayField(Map(collections, key), "items"); }
        private static ClientFailure Shape() { return ClientData.Fail("SUMMARY_SHAPE_INVALID", "摘要来源字段不完整。", "保留原始响应并核对客户端版本，不补默认值或猜测状态。"); }
    }
}
