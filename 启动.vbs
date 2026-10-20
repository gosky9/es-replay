' ============ Launcher (double-click to run) ============
' Starts the local server via pythonw.exe (GUI subsystem, NO console window),
' waits for the port file, then opens the browser.
' NOTE: keep this file pure ASCII. VBScript reads .vbs in the system ANSI
' codepage; UTF-8 Chinese comments get mangled and break the script.
Option Explicit

Dim sh, fso, base, py, portFile, port, i, tf

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)

py = "C:/Python312/pythonw.exe"
If Not fso.FileExists(py) Then
    py = "C:/Users/gosky9/.workbuddy/binaries/python/versions/3.13.12/pythonw.exe"
End If
If Not fso.FileExists(py) Then
    sh.Popup "pythonw.exe not found. Please check your Python installation.", 6, "ES Replay"
    WScript.Quit 1
End If

' window style 0 + pythonw (GUI subsystem) => no window ever
sh.Run """" & py & """ """ & base & "\server.py""", 0, False

' wait for port.txt (server ready), max 5 seconds
port = "8899"
portFile = base & "\port.txt"
For i = 1 To 20
    WScript.Sleep 250
    If fso.FileExists(portFile) Then
        Set tf = fso.OpenTextFile(portFile, 1)
        port = Trim(tf.ReadLine())
        tf.Close
        Exit For
    End If
Next

sh.Run "http://127.0.0.1:" & port & "/"
