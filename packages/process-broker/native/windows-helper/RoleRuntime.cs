using System;
using AiDevOs.WindowsRuntime;

namespace AiDevOs.WindowsHelper;

/// <summary>The helper's sealed operational command surface.</summary>
internal static class RoleRuntime
{
    private const string HelperImageName = "AI.DevOS.WindowsHelper.exe";

    internal static bool TryDispatch(string[] args, out int exitCode)
    {
        exitCode = 64;
        if (!string.Equals(args[0], "run-session", StringComparison.Ordinal))
        {
            return false;
        }

        if (args.Length != 4)
        {
            return true;
        }

        try
        {
            using RuntimeClosureLease closure =
                RuntimeClosureLease.AcquireFromCurrentImage(HelperImageName);
            closure.AssertOpen();
            exitCode = WindowsRuntimeBoundary.RunLifecycleWorker(
                args[1],
                args[2],
                args[3],
                closure.RunToken);
        }
        catch (Exception exception) when (!IsFatal(exception))
        {
            exitCode = 70;
        }

        return true;
    }

    internal static bool RunReadOnlySelfTest()
    {
        string[] valid = ["run-session", "1", "2", "3"];
        string[] missing = ["run-session", "1", "2"];
        return RuntimeClosureLease.RunReadOnlySelfTest() &&
            IsCommandShape(valid) &&
            !IsCommandShape(missing);
    }

    private static bool IsCommandShape(string[] args) =>
        args.Length == 4 && string.Equals(args[0], "run-session", StringComparison.Ordinal);

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException or StackOverflowException or AccessViolationException;
}
