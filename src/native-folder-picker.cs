using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Web.Script.Serialization;

public static class ResearchFolderPicker {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    // WSL's background service does not inherit the browser's foreground input
    // queue. Attach only for this user-requested activation and always detach.
    static void ActivateOwner(IntPtr owner) {
        uint current = GetCurrentThreadId();
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
        try { SetForegroundWindow(owner); }
        finally { if (attached) AttachThreadInput(current, foreground, false); }
    }
    [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleWindow {
        void GetWindow(out IntPtr window);
        void ContextSensitiveHelp(bool enter);
    }
    [ComVisible(true), Guid("973510DB-7D7F-452B-8975-74A85828D354"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialogEvents {
        [PreserveSig] int OnFileOk(IntPtr dialog);
        [PreserveSig] int OnFolderChanging(IntPtr dialog, IntPtr folder);
        [PreserveSig] int OnFolderChange(IntPtr dialog);
        [PreserveSig] int OnSelectionChange(IntPtr dialog);
        [PreserveSig] int OnShareViolation(IntPtr dialog, IntPtr item, out uint response);
        [PreserveSig] int OnTypeChange(IntPtr dialog);
        [PreserveSig] int OnOverwrite(IntPtr dialog, IntPtr item, out uint response);
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public class DialogEvents : IFileDialogEvents {
        bool presented;
        public int OnFolderChange(IntPtr pointer) {
            if (presented) return 0;
            object instance = Marshal.GetObjectForIUnknown(pointer);
            try {
                IntPtr window; ((IOleWindow)instance).GetWindow(out window);
                if (window == IntPtr.Zero) return 0;
                presented = true;
                ShowWindow(window, 9); // Restore only our dialog, never the browser.
                SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x43); // Show above existing windows.
                ActivateOwner(window);
                SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x03); // Do not keep it always-on-top.
            } finally { Marshal.ReleaseComObject(instance); }
            return 0;
        }
        public int OnFileOk(IntPtr dialog) { return 0; }
        public int OnFolderChanging(IntPtr dialog, IntPtr folder) { return 0; }
        public int OnSelectionChange(IntPtr dialog) { return 0; }
        public int OnShareViolation(IntPtr dialog, IntPtr item, out uint response) { response = 0; return 0; }
        public int OnTypeChange(IntPtr dialog) { return 0; }
        public int OnOverwrite(IntPtr dialog, IntPtr item, out uint response) { response = 0; return 0; }
    }
    // IFileDialog's ABI prefix through Close; method order follows shobjidl_core.h.
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IFileDialogEvents events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        [PreserveSig] int Close(int result);
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
    }
    static string cancelFile;
    static string output;
    static readonly object resultLock = new object();
    static bool written;
    static void WriteResult(string result) {
        lock (resultLock) {
            if (written) return;
            File.WriteAllText(output + ".tmp", result, new UTF8Encoding(false));
            File.Move(output + ".tmp", output);
            written = true;
        }
    }
    [STAThread]
    public static int Main(string[] args) {
        Opening = Array.IndexOf(args, "--open") >= 0;
        for (int i = 0; i + 1 < args.Length; i++) {
            if (args[i] == "--result") output = args[i + 1];
            if (args[i] == "--cancel") cancelFile = args[i + 1];
        }
        if (output == null) return 2;
        try {
            string result;
            if (Array.IndexOf(args, "--probe") >= 0) {
                Probe(); result = "{\"available\":true}";
            } else {
                // The shell dialog owns its message loop. Watch cancellation off
                // the UI thread so it also works while that loop is blocked.
                var watcher = new Thread(delegate() {
                    var elapsed = Stopwatch.StartNew();
                    while (!CancelledByParent && elapsed.Elapsed.TotalMinutes < 5) Thread.Sleep(100);
                    try { WriteResult("{\"directory\":null}"); } catch { }
                    Environment.Exit(0);
                });
                watcher.IsBackground = true; watcher.Start();
                result = new JavaScriptSerializer().Serialize(new { directory = Pick() });
            }
            WriteResult(result);
            return 0;
        } catch {
            try { File.WriteAllText(output, "{\"error\":\"native_picker_failed\"}", new UTF8Encoding(false)); } catch { }
            return 1;
        }
    }
    static bool CancelledByParent { get { return cancelFile != null && File.Exists(cancelFile); } }
    public static bool Opening;
    const int Cancelled = unchecked((int)0x800704C7);
    static IFileDialog Create() {
        var dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
        try {
            uint options; dialog.GetOptions(out options);
            // Native Explorer folder selection; only filesystem paths are returned.
            dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x02000000);
            dialog.SetTitle(Opening ? "打开已有项目：选择代码或研究文件夹" : "创建研究项目：选择保存新项目的父文件夹");
            dialog.SetOkButtonLabel(Opening ? "打开项目" : "选择保存位置");
            return dialog;
        } catch { Marshal.FinalReleaseComObject(dialog); throw; }
    }
    public static void Probe() {
        var dialog = Create(); Marshal.FinalReleaseComObject(dialog);
    }
    public static string Pick() {
        var dialog = Create(); IShellItem item = null;
        uint cookie; var events = new DialogEvents(); dialog.Advise(events, out cookie);
        // Give the shell dialog a visible, active GUI owner on the current monitor.
        // The transparent owner has no taskbar entry and is disposed with the dialog.
        using (var owner = new System.Windows.Forms.Form()) {
            var area = System.Windows.Forms.Screen.FromHandle(GetForegroundWindow()).WorkingArea;
            owner.ShowInTaskbar = false;
            owner.FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
            owner.StartPosition = System.Windows.Forms.FormStartPosition.Manual;
            owner.SetBounds(area.Left + area.Width / 2, area.Top + area.Height / 2, 1, 1);
            owner.Opacity = 0;
            try {
                if (CancelledByParent) return null;
                owner.Show();
                ActivateOwner(owner.Handle);
                int result = dialog.Show(owner.Handle);
                if (result == Cancelled || CancelledByParent) return null;
                Marshal.ThrowExceptionForHR(result);
                dialog.GetResult(out item);
                IntPtr name; item.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
                try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
            } finally {
                owner.Hide(); dialog.Unadvise(cookie); if (item != null) Marshal.FinalReleaseComObject(item);
                Marshal.FinalReleaseComObject(dialog);
            }
        }
    }
}
