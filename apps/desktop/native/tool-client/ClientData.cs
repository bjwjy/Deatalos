using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace HydraulicTools
{
    // Boundary parsing only: no CLR type deserialization or project-authored code.
    internal static class ClientData
    {
        internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304, RecursionLimit = 48 };

        internal static ClientFailure Fail(string code, string message, string suggestion)
        {
            return new ClientFailure(code, message, suggestion);
        }

        internal static Dictionary<string, object> Object(string text)
        {
            object value;
            try { value = Json.DeserializeObject(text); }
            catch (ArgumentException) { throw Fail("JSON_INVALID", "JSON格式无效。", "使用UTF-8 JSON请求；工程说明不是请求正文。"); }
            var result = value as Dictionary<string, object>;
            if (result == null) throw Fail("JSON_INVALID", "JSON须为对象。", "按capabilities中的请求结构重试。");
            return result;
        }

        internal static string Text(Dictionary<string, object> value, string key)
        {
            object item;
            if (!value.TryGetValue(key, out item) || !(item is string))
                throw Fail("RECORD_INVALID", "连接或工程记录字段无效。", "在目标工作台重开AI接入；不要手改受管数据。");
            return (string)item;
        }

        internal static bool VersionOne(Dictionary<string, object> value)
        {
            object version;
            return value.TryGetValue("version", out version) && version is int && (int)version == 1;
        }

        internal static void Keys(Dictionary<string, object> value, params string[] allowed)
        {
            foreach (string key in value.Keys)
                if (Array.IndexOf(allowed, key) < 0)
                    throw Fail("RECORD_INVALID", "连接记录包含未知字段。", "使用对应工作台版本的客户端。");
        }

        internal static void Regular(string value, string pattern)
        {
            if (!Regex.IsMatch(value, pattern))
                throw Fail("RECORD_INVALID", "连接或工程身份格式无效。", "重新打开目标工程并启用AI。");
        }

        internal static string FullDirectory(string value)
        {
            if (String.IsNullOrEmpty(value) || !Path.IsPathRooted(value) || value.StartsWith(@"\\", StringComparison.Ordinal))
                throw Fail("PATH_INVALID", "仅支持本机绝对目录。", "选择当前账户下的工程目录。");
            string full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
            CheckPath(full);
            return full;
        }

        internal static void CheckPath(string file)
        {
            // Reject links at every existing level; credentials never follow project links.
            for (string current = file; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw Fail("PATH_LINK_DENIED", "接入路径不能是链接或目录联接。", "使用真实工程/应用数据目录。");
        }

        internal static string Read(string file, int maximum)
        {
            CheckPath(file);
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
                return ReadStream(stream, maximum);
        }

        internal static string ReadStream(Stream stream, int maximum)
        {
            using (var buffer = new MemoryStream())
            {
                var part = new byte[8192];
                int count;
                while ((count = stream.Read(part, 0, part.Length)) != 0)
                {
                    if (buffer.Length + count > maximum)
                        throw Fail("PAYLOAD_LIMIT", "数据超过客户端容量。", "缩小请求/读取范围，不截断数据。");
                    buffer.Write(part, 0, count);
                }
                return Utf8.GetString(buffer.ToArray()).TrimStart('\uFEFF');
            }
        }

        internal static string ReadLine(TextReader reader)
        {
            var line = new StringBuilder();
            int character;
            while ((character = reader.Read()) != -1 && character != '\n')
            {
                if (line.Length >= 1048576) throw Fail("PAYLOAD_LIMIT", "持续连接单条请求超过容量。", "每行一条JSON，缩小请求范围。");
                line.Append((char)character);
            }
            if (character == -1 && line.Length == 0) return null;
            string value = line.ToString();
            if (Utf8.GetByteCount(value) > 1048576) throw Fail("PAYLOAD_LIMIT", "持续连接单条请求超过1 MiB。", "缩小请求范围。");
            return value;
        }

        internal static string Hex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }

        internal static byte[] Bytes(string hex)
        {
            Regular(hex, "\\A(?:[a-fA-F0-9]{2}){50,4096}\\z");
            var result = new byte[hex.Length / 2];
            for (int i = 0; i < result.Length; i++) result[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return result;
        }
    }
}
