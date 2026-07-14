using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class NixartCourseManagerLauncher
{
    [STAThread]
    private static void Main()
    {
        try
        {
            var root = AppDomain.CurrentDomain.BaseDirectory;
            var script = Path.Combine(root, "scripts", "nixart-course-manager.ps1");
            if (!File.Exists(script))
                throw new FileNotFoundException("Không tìm thấy giao diện quản lý khóa học.", script);

            var powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            Process.Start(new ProcessStartInfo
            {
                FileName = powershell,
                Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Nixart Course Manager", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
