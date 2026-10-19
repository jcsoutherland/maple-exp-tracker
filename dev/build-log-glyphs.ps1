# Builds src/core/data/logfont.json: the pickup log's font as the game draws it (Arial 12 px through Windows GDI,
# not antialiased), one bitmap per printable ASCII character with its advance. The log matcher (src/core/logmatch.ts)
# spells out any message from these, the same way the game does (GDI's TextOut doesn't kern).
#   powershell -ExecutionPolicy Bypass -File dev/build-log-glyphs.ps1
param([string]$out = "$PSScriptRoot\..\src\core\data\logfont.json", [string]$face = "Arial", [int]$px = 12)
$src = @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class LogFont {
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr h);
  [DllImport("gdi32.dll")] static extern IntPtr CreateFontW(int h,int w,int e,int o,int wt,uint it,uint ul,uint so,uint cs,uint op,uint cp,uint q,uint pf,[MarshalAs(UnmanagedType.LPWStr)] string face);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern uint SetTextColor(IntPtr dc, uint c);
  [DllImport("gdi32.dll")] static extern int SetBkMode(IntPtr dc, int m);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool TextOutW(IntPtr dc, int x, int y, string s, int n);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] static extern bool GetTextExtentPoint32W(IntPtr dc, string s, int n, out SIZE sz);
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, byte[] bmi, uint u, out IntPtr bits, IntPtr s, uint o);
  public static string Run(string face, int px) {
    const int W = 64, H = 32, P = 8;
    IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
    byte[] bmi = new byte[40]; BitConverter.GetBytes(40).CopyTo(bmi,0); BitConverter.GetBytes(W).CopyTo(bmi,4); BitConverter.GetBytes(-H).CopyTo(bmi,8);
    BitConverter.GetBytes((short)1).CopyTo(bmi,12); BitConverter.GetBytes((short)32).CopyTo(bmi,14);
    IntPtr bits; IntPtr dib = CreateDIBSection(dc, bmi, 0, out bits, IntPtr.Zero, 0); SelectObject(dc, dib);
    // NONANTIALIASED_QUALITY (3): the bilevel glyphs the game shows
    SelectObject(dc, CreateFontW(-px,0,0,0,400,0,0,0,1,0,0,3,0,face)); SetTextColor(dc, 0xFFFFFF); SetBkMode(dc, 1);
    var sb = new StringBuilder(); sb.AppendFormat("{{\"face\":\"{0}\",\"px\":{1},\"glyphs\":{{", face, px);
    byte[] buf = new byte[W*H*4];
    for (int c = 32; c < 127; c++) {
      string s = ((char)c).ToString();
      Marshal.Copy(new byte[W*H*4], 0, bits, W*H*4);
      TextOutW(dc, P, P, s, 1); Marshal.Copy(bits, buf, 0, buf.Length);
      SIZE sz; GetTextExtentPoint32W(dc, s, 1, out sz);
      int x0=W,x1=-1,y0=H,y1=-1;
      for (int y=0;y<H;y++) for (int x=0;x<W;x++) if (buf[(y*W+x)*4]>128){x0=Math.Min(x0,x);x1=Math.Max(x1,x);y0=Math.Min(y0,y);y1=Math.Max(y1,y);}
      var rows = new StringBuilder();
      if (x1 >= 0) for (int y=y0;y<=y1;y++) { if (y>y0) rows.Append(' '); for (int x=x0;x<=x1;x++) rows.Append(buf[(y*W+x)*4]>128?'#':'.'); }
      string key = s == "\"" ? "\\\"" : s == "\\" ? "\\\\" : s;
      if (c > 32) sb.Append(",");
      // x/y: the ink's offset from the pen position and the text cell's top; adv: how far the pen moves
      sb.AppendFormat("\"{0}\":{{\"adv\":{1},\"x\":{2},\"y\":{3},\"rows\":\"{4}\"}}", key, sz.cx, x1 >= 0 ? x0-P : 0, x1 >= 0 ? y0-P : 0, rows);
    }
    return sb.Append("}}").ToString();
  }
}
'@
Add-Type -TypeDefinition $src
[IO.File]::WriteAllText([IO.Path]::GetFullPath($out), [LogFont]::Run($face, $px))
Write-Output "wrote $out"
