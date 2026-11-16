using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace HydraulicTools
{
    internal sealed class ToolConnection
    {
        internal readonly string ProjectId;
        internal readonly string Directory;
        internal readonly string Endpoint;
        internal readonly string ConnectionId;
        internal readonly string Token;

        internal ToolConnection(string project, string explicitDirectory)
        {
            Directory = ClientData.FullDirectory(project);
            var entry = ClientData.Object(ClientData.Read(Path.Combine(Directory, "工程.hydproj"), 16000));
            ClientData.Keys(entry, "format", "version", "projectId", "saveId", "documentSha256", "guideSha256");
            if (ClientData.Text(entry, "format") != "HydraulicProjectFolder" || !ClientData.VersionOne(entry))
                throw ClientData.Fail("PROJECT_INVALID", "不是受支持的文件夹工程。", "从进阶工作台打开工程.hydproj。");
            ProjectId = ClientData.Text(entry, "projectId");
            ClientData.Regular(ProjectId, @"\A[-\w]{1,40}\z");
            ClientData.Regular(ClientData.Text(entry, "saveId"), @"\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z");
            ClientData.Regular(ClientData.Text(entry, "documentSha256"), @"\A[a-f0-9]{64}\z");
            ClientData.Regular(ClientData.Text(entry, "guideSha256"), @"\A[a-f0-9]{64}\z");
            string file;
            string expectedId = null;
            if (explicitDirectory != null)
                file = Path.Combine(ClientData.FullDirectory(explicitDirectory), "ai-connection.json");
            else
            {
                string registry = Environment.GetEnvironmentVariable("HYD_TOOLS_REGISTRY_DIR");
                if (String.IsNullOrEmpty(registry)) registry = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HydraulicWorkbench", "ai-active");
                if (!System.IO.Directory.Exists(registry))
                    throw ClientData.Fail("CONNECTION_NOT_FOUND", "没有找到该工程的活动连接；不能据此判断开关状态。", "在目标工作台打开此工程并开启AI；旧工作台可显式指定连接目录。");
                registry = ClientData.FullDirectory(registry);
                var candidates = new List<Dictionary<string, object>>();
                int count = 0;
                foreach (string index in System.IO.Directory.EnumerateFiles(registry, "*.json", SearchOption.TopDirectoryOnly))
                {
                    if (++count > 128) throw ClientData.Fail("REGISTRY_LIMIT", "活动连接目录超过容量。", "关闭不用的工作台，核查残留连接记录。");
                    // A broken index fails explicitly; it cannot silently choose another live instance.
                    var record = ClientData.Object(ClientData.Read(index, 16384));
                    ClientData.Keys(record, "format", "version", "directory", "projectId", "documentSessionId", "connectionId", "discoveryPath");
                    if (ClientData.Text(record, "format") != "HydraulicToolsTarget" || !ClientData.VersionOne(record))
                        throw ClientData.Fail("RECORD_INVALID", "活动工程连接索引无效。", "重开对应工作台AI接入。");
                    if (String.Equals(ClientData.Text(record, "directory"), Directory, StringComparison.OrdinalIgnoreCase) && ClientData.Text(record, "projectId") == ProjectId)
                        candidates.Add(record);
                }
                if (candidates.Count != 1)
                    throw ClientData.Fail(candidates.Count == 0 ? "CONNECTION_NOT_FOUND" : "TARGET_AMBIGUOUS", candidates.Count == 0 ? "没有找到该工程的活动连接。" : "同一工程存在多个连接，未选择或重发。", "在目标窗口重开AI；多个窗口时显式指定该窗口显示的连接目录。");
                file = ClientData.Text(candidates[0], "discoveryPath");
                expectedId = ClientData.Text(candidates[0], "connectionId");
            }
            if (!Path.IsPathRooted(file) || file.StartsWith(@"\\", StringComparison.Ordinal)) throw ClientData.Fail("PATH_INVALID", "发现记录路径无效。", "重开目标工作台AI。");
            var connection = ClientData.Object(ClientData.Read(file, 16384));
            ClientData.Keys(connection, "format", "version", "protection", "endpoint", "connectionId", "protectedToken");
            if (ClientData.Text(connection, "format") != "HydraulicToolsConnection" || !ClientData.VersionOne(connection) || ClientData.Text(connection, "protection") != "windows-dpapi-current-user")
                throw ClientData.Fail("RECORD_INVALID", "发现记录协议不受支持。", "使用当前工作台的客户端。");
            Endpoint = ClientData.Text(connection, "endpoint");
            ClientData.Regular(Endpoint, @"\Ahttp://127\.0\.0\.1:[0-9]+/tools\z");
            ConnectionId = ClientData.Text(connection, "connectionId");
            ClientData.Regular(ConnectionId, @"\Atools_[a-zA-Z0-9_-]{1,40}\z");
            if (expectedId != null && expectedId != ConnectionId) throw ClientData.Fail("CONNECTION_STALE", "发现记录已被新连接替代。", "重新读取，不复用旧候选。");
            byte[] plain;
            try { plain = ProtectedData.Unprotect(ClientData.Bytes(ClientData.Text(connection, "protectedToken")), null, DataProtectionScope.CurrentUser); }
            catch (CryptographicException) { throw ClientData.Fail("ACCOUNT_DECRYPT_FAILED", "当前进程不能解密连接，可能为沙箱身份或DPAPI访问限制。", "核对工作台与客户端账户；若账户一致，只按AI客户端审批流程为固定客户端和目标工程申请必要权限，未获授权则停止。工作台开关不能授予沙箱权限，不向聊天提供令牌。"); }
            try { Token = Encoding.Unicode.GetString(plain); }
            finally { Array.Clear(plain, 0, plain.Length); }
            ClientData.Regular(Token, @"\A[a-f0-9]{64}\z");
        }
    }
}
