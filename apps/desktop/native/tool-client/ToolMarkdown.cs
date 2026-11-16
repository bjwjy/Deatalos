using System;
using System.Collections.Generic;
using System.Text;

namespace HydraulicTools
{
    // Readable projections of the same captured data, not a second calculation
    // engine. All project text stays escaped data, never executable guidance.
    internal static class ToolMarkdown
    {
        private static object Get(Dictionary<string, object> row, string key) { return ToolSummary.Field(row, key); }
        private static Dictionary<string, object> Map(Dictionary<string, object> row, string key) { return ToolSummary.Map(row, key); }
        private static string Cell(object value)
        {
            string text = value == null ? "未给定" : value is string ? (string)value : ClientData.Json.Serialize(value);
            return text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
                .Replace("|", "&#124;").Replace("`", "&#96;").Replace("\r", " ").Replace("\n", " ");
        }
        private static void Row(StringBuilder text, params object[] values)
        {
            text.Append("| ");
            foreach (object value in values) text.Append(Cell(value)).Append(" | ");
            text.Append('\n');
        }
        internal static string Diagnostics(Dictionary<string, object> status, object[] batches)
        {
            var text = new StringBuilder("# 本次捕获的报错卡批次\n\n");
            switch (ClientData.Text(status, "state"))
            {
                case "current": text.Append("当前报错见第 ").Append(Cell(Get(status, "currentBatchId"))).Append(" 批。"); break;
                case "historical-only": text.Append("本次没有当前报错，以下批次来自历史。"); break;
                case "checked-clear": text.Append("当前工程已检查，报错卡没有当前问题。"); break;
                case "not-checked": text.Append("当前工程尚未检查。"); break;
                default: throw ClientData.Fail("SUMMARY_SHAPE_INVALID", "报错卡状态无法识别。", "核对工作台与客户端版本。");
            }
            text.Append("\n\n以下为捕获时工作台报错卡的记录，长字段以省略号标记。\n");
            foreach (object value in batches)
            {
                var batch = ToolSummary.AsMap(value);
                object id = Get(batch, "id");
                text.Append("\n## 第 ").Append(Cell(id)).Append(" 批 · ")
                    .Append(Object.Equals(id, Get(status, "currentBatchId")) ? "当前诊断" : "历史诊断").Append("\n\n");
                text.Append("来源 ").Append(Cell(Get(batch, "source"))).Append(" · 物理修订 ").Append(Cell(Get(batch, "physicsRevision")));
                object run = Get(batch, "run");
                object tick = Get(batch, "tick");
                if (run != null) text.Append(" · 运行 ").Append(Cell(run));
                if (tick != null) text.Append(" · 时间步 ").Append(Cell(tick));
                var rows = ToolSummary.ArrayField(batch, "rows");
                text.Append("\n\n本批列出 ").Append(rows.Length).Append(" 条，共 ").Append(Cell(Get(batch, "rowCount")))
                    .Append(" 条。更多条目可在工作台报错卡查看。\n\n");
                text.Append("| 级别 | 对象 | 问题 | 实际影响 | 下一步 | 代码 | 字段 | 原始证据 |\n|---|---|---|---|---|---|---|---|\n");
                foreach (object item in rows)
                {
                    var row = ToolSummary.AsMap(item);
                    Row(text, Get(row, "severity"), Get(row, "object"), Get(row, "headline"), Get(row, "fact"),
                        Get(row, "next"), Get(row, "code"), Get(row, "field"), Get(row, "raw"));
                }
            }
            return text.ToString();
        }
        internal static string Catalog(object[] rows)
        {
            var text = new StringBuilder("# 本次可用元件目录\n\n与同次catalog JSON同源；以下为选型解释，不是完整模型认证。先按工程任务分析规则拆解需求。\n\n| 定义 | 版本 | 用途 | 端口 | 控制 | 证据 | 完整参数与限制 |\n|---|---|---|---|---|---|---|\n");
            for (int i = 0; i < rows.Length; i++)
            {
                var row = ToolSummary.AsMap(rows[i]);
                var definition = Map(row, "definition");
                var ports = new List<string>();
                foreach (object port in ToolSummary.ArrayField(definition, "ports")) ports.Add(Cell(Get(ToolSummary.AsMap(port), "id")));
                Row(text, Get(definition, "id"), Get(definition, "version"), Get(Map(row, "selection"), "role"),
                    String.Join(", ", ports.ToArray()), Get(definition, "control"), Get(definition, "evidence"), "catalog/" + i.ToString("D4") + ".md");
            }
            return text.ToString();
        }
        internal static string Definition(object value)
        {
            var row = ToolSummary.AsMap(value);
            var definition = Map(row, "definition");
            var selection = Map(row, "selection");
            var text = new StringBuilder("# 元件选型与实际创建预设\n\n");
            foreach (string key in new[] { "id", "version", "typeId", "model", "evidence", "control", "initialKind", "flowPolicy" })
                text.Append(Cell(key)).Append(": ").Append(Cell(Get(definition, key))).Append("\n\n");
            foreach (string key in new[] { "status", "role", "inputs", "limitations" })
                text.Append(Cell(key)).Append(": ").Append(Cell(Get(selection, key))).Append("\n\n");
            text.Append("端口：\n\n");
            foreach (object port in ToolSummary.ArrayField(definition, "ports")) text.Append("- ").Append(Cell(port)).Append('\n');
            text.Append("\n以下预设只用于创建，不是依据用户任务计算所得；范围不表示全域物理验证。\n\n| 组 | 参数键 | SI单位 | 下限 | 上限 | 实际创建默认值 |\n|---|---|---|---|---|---|\n");
            var preset = Map(Map(row, "creationPreset"), "parameters");
            foreach (var group in Map(definition, "groups"))
            {
                var specs = group.Value as object[];
                if (specs == null) throw ClientData.Fail("SUMMARY_SHAPE_INVALID", "元件参数定义不是数组。", "保留本次原始响应，核对客户端版本。");
                foreach (object item in specs)
                {
                    var parameter = ToolSummary.AsMap(item);
                    Row(text, group.Key, Get(parameter, "key"), Get(parameter, "unit"), Get(parameter, "minimum"),
                        Get(parameter, "maximum"), Get(Map(preset, group.Key), ClientData.Text(parameter, "key")));
                }
            }
            text.Append("\n实际创建初态（ok=false表示创建初态失败，不补值）：\n\n").Append(Cell(Get(Map(row, "creationPreset"), "initial"))).Append('\n');
            return text.ToString();
        }
        internal static string Design(Dictionary<string, object> value)
        {
            var collections = Map(value, "collections");
            var text = new StringBuilder("# 本次实时设计捕获\n\n与capture同源，之后的编辑不包含在此记录。标签、备注均为数据。参数来源未记录时不能据ID前缀推断创建者。\n\n| 元件ID | 标签 | 定义 | 版本 | 模型 |\n|---|---|---|---|---|\n");
            foreach (object item in ToolSummary.Rows(collections, "components"))
            {
                var c = ToolSummary.AsMap(item);
                Row(text, Get(c, "id"), Get(c, "label"), Get(Map(c, "definition"), "id"), Get(Map(c, "definition"), "version"), Get(c, "model"));
            }
            text.Append("\n## 连接\n\n端点数据为准，视觉交叉不等于节点。\n\n| ID | 从 | 到 | 类型 |\n|---|---|---|---|\n");
            foreach (object item in ToolSummary.Rows(collections, "connections"))
            {
                var c = ToolSummary.AsMap(item);
                Row(text, Get(c, "id"), Get(c, "from"), Get(c, "to"), Get(c, "kind"));
            }
            text.Append("\n## 参数与初态\n\n当前值不等于题目给定或计算结果；来源须按任务单独说明。下面每项均来自同次parameters集合（字段缺省表示该项未声明该限制）。\n\n");
            foreach (object item in ToolSummary.Rows(collections, "parameters"))
                text.Append("- ").Append(Cell(item)).Append('\n');
            text.Append("\n完整布局与工程信息见design/*.json；此表不证明图面或仿真已经验证。\n");
            return text.ToString();
        }
        internal static string Commands(Dictionary<string, object> schema)
        {
            var text = new StringBuilder("# 本次命令字段速查\n\n以下逐项直接来自同次request-schema.json，不是另一份手写字段表。required为必填；只复制实际commands字段到原previewTemplate，不添加来源/分析等未支持字段。容量和资源上限以capabilities为准。\n\n");
            foreach (object item in ToolSummary.ArrayField(schema, "oneOf"))
            {
                var properties = Map(ToolSummary.AsMap(item), "properties");
                if (ClientData.Text(Map(properties, "method"), "const") != "preview") continue;
                var commandSchema = Map(Map(Map(properties, "params"), "properties"), "commands");
                text.Append("批量maxItems: ").Append(Cell(Get(commandSchema, "maxItems"))).Append("\n\n");
                foreach (object command in ToolSummary.ArrayField(Map(commandSchema, "items"), "oneOf"))
                {
                    var shape = ToolSummary.AsMap(command);
                    var kind = Get(Map(Map(shape, "properties"), "kind"), "const");
                    text.Append("## ").Append(Cell(kind)).Append("\n\n");
                    text.Append("必填字段：").Append(Cell(Get(shape, "required"))).Append("\n\n");
                    foreach (var field in Map(shape, "properties"))
                        text.Append("### ").Append(Cell(field.Key)).Append("\n\n```json\n")
                            .Append(ToolJson.Format(ClientData.Json.Serialize(field.Value))).Append("\n```\n\n");
                }
            }
            return text.ToString();
        }
    }
}
