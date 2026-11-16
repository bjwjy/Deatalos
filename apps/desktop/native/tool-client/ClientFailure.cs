using System;

namespace HydraulicTools
{
    internal sealed class ClientFailure : Exception
    {
        internal readonly string Code;
        internal readonly string Suggestion;
        internal ClientFailure(string code, string message, string suggestion) : base(message)
        {
            Code = code;
            Suggestion = suggestion;
        }
    }
}
