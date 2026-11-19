using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Collections.Generic;

// Read-only inspection for the opt-in native UI regression. No focus changes.
class PickerWindowInspector {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    static void Main(string[] args) {
        var results = new List<object>(); var foreground = GetForegroundWindow();
        foreach (var process in Process.GetProcessesByName("native-folder-picker")) {
            EnumWindows(delegate(IntPtr window, IntPtr data) {
                uint pid; GetWindowThreadProcessId(window, out pid);
                if (pid != process.Id || !IsWindowVisible(window)) return true;
                var title = new StringBuilder(512); GetWindowText(window, title, 512);
                if (title.Length > 0) results.Add(new { title = title.ToString(), foreground = foreground == window, minimized = IsIconic(window) });
                return true;
            }, IntPtr.Zero);
        }
        File.WriteAllText(args[0], new JavaScriptSerializer().Serialize(results), new UTF8Encoding(false));
    }
}
