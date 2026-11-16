using System;
using System.Text;

namespace HydraulicTools
{
    // Formatting of already parsed/serialized JSON only. Never split or alter a
    // string token to meet a line-length target (paths/escapes must round-trip).
    internal static class ToolJson
    {
        internal static string Format(string json)
        {
            var output = new StringBuilder();
            bool quoted = false, escaped = false;
            int depth = 0;
            foreach (char ch in json)
            {
                if (quoted)
                {
                    output.Append(ch);
                    if (escaped) escaped = false;
                    else if (ch == '\\') escaped = true;
                    else if (ch == '"') quoted = false;
                    continue;
                }
                if (Char.IsWhiteSpace(ch)) continue;
                if (ch == '"') { output.Append(ch); quoted = true; }
                else if (ch == '{' || ch == '[')
                {
                    output.Append(ch).Append('\n').Append(' ', ++depth * 2);
                }
                else if (ch == '}' || ch == ']')
                {
                    depth--;
                    output.Append('\n').Append(' ', depth * 2).Append(ch);
                }
                else if (ch == ',') output.Append(ch).Append('\n').Append(' ', depth * 2);
                else if (ch == ':') output.Append(": ");
                else output.Append(ch);
            }
            return output.ToString();
        }
    }
}
