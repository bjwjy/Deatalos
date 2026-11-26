using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static class Program
{
    // Current-user DPAPI only. There is no project, network, or command API here.
    private static int Main(string[] args)
    {
        if (args.Length != 1 || (args[0] != "protect" && args[0] != "unprotect")) return 2;
        try
        {
            var data = new char[8193];
            int count = Console.In.ReadBlock(data, 0, data.Length);
            if (count == data.Length) return 2;
            string input = new string(data, 0, count);
            bool protect = args[0] == "protect";
            if (!Regex.IsMatch(input, protect ? @"\A[a-f0-9]{64}\z" : @"\A(?:[a-fA-F0-9]{2}){50,4096}\z")) return 2;
            if (protect) {
                byte[] token = Encoding.ASCII.GetBytes(input);
                try { Console.Write(BitConverter.ToString(ProtectedData.Protect(token, null, DataProtectionScope.CurrentUser)).Replace("-", "")); }
                finally { Array.Clear(token, 0, token.Length); }
            } else {
                byte[] cipher = new byte[input.Length / 2];
                for (int i = 0; i < cipher.Length; i++) cipher[i] = Convert.ToByte(input.Substring(i * 2, 2), 16);
                byte[] token = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser);
                try {
                    string text = Encoding.ASCII.GetString(token);
                    if (!Regex.IsMatch(text, @"\A[a-f0-9]{64}\z")) return 2;
                    Console.Write(text);
                } finally { Array.Clear(token, 0, token.Length); }
            }
            return 0;
        } catch (CryptographicException) { return 1; }
    }
}
