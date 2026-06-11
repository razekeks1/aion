// AION clipboard image grab — paste screenshots straight into the chat.
// Windows: PowerShell + System.Windows.Forms · macOS: osascript · Linux: xclip/wl-paste.
// Returns { b64, mime, bytes } or null if the clipboard holds no image.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 * 1024, ...opts },
    (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});

export async function grabClipboardImage() {
  const tmp = path.join(os.tmpdir(), `aion-clip-${Date.now()}.png`);
  try {
    if (process.platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$img=[System.Windows.Forms.Clipboard]::GetImage();",
        `if($img){ $img.Save('${tmp.replace(/\\/g, "\\\\")}',[System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'OK' } else { Write-Output 'NONE' }`,
      ].join(" ");
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", ps]);
      if (!/OK/.test(stdout)) return null;
    } else if (process.platform === "darwin") {
      // AppleScript writes the clipboard PNG to disk if present
      const osa = `try
  set png to (the clipboard as «class PNGf»)
  set f to open for access POSIX file "${tmp}" with write permission
  write png to f
  close access f
  return "OK"
on error
  try
    close access POSIX file "${tmp}"
  end try
  return "NONE"
end try`;
      const { stdout } = await run("osascript", ["-e", osa]);
      if (!/OK/.test(stdout)) return null;
    } else {
      // Linux: try Wayland then X11
      let ok = false;
      const wl = await run("sh", ["-c", `wl-paste --type image/png > "${tmp}"`]);
      if (!wl.err && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) ok = true;
      if (!ok) {
        const xc = await run("sh", ["-c", `xclip -selection clipboard -t image/png -o > "${tmp}"`]);
        if (!xc.err && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) ok = true;
      }
      if (!ok) return null;
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return null;
    const buf = fs.readFileSync(tmp);
    return { b64: buf.toString("base64"), mime: "image/png", bytes: buf.length };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
