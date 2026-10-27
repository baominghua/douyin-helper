' Silent sink for the bitbrowser:// protocol.
' Registered by the app so that a page probing for BitBrowser
' (Douyin's client does this from a hidden iframe) never triggers
' the Windows "no app can open this link" dialog.
' It only records the call and exits. No window, no network.
Option Explicit

Dim fso, sh, url, logDir, logFile, f, ts

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

url = ""
If WScript.Arguments.Count > 0 Then url = WScript.Arguments(0)

logDir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\DouyinHelper\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\protocol-calls.log"

ts = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & " " & _
     Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)

On Error Resume Next
Set f = fso.OpenTextFile(logFile, 8, True)
f.WriteLine ts & "  " & url
f.Close
