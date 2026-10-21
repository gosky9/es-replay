' ============ Launcher (double-click to run) ============
' Starts the local server via pythonw.exe (GUI subsystem, NO console window),
' waits for the port file, then opens the browser.
'
' 2026-10-22: it now PINGS first. If a server from a previous launch is still
' answering on port.txt, it only opens the browser and spawns nothing.
' Before this check every double-click left another pythonw.exe behind
' (19 zombies were found, only 1 actually serving).
' NOTE: keep this file pure ASCII. VBScript reads .vbs in the system ANSI
' codepage; UTF-8 Chinese comments get mangled and break the script.
'
' Optional switch:  wscript 启动.vbs /nobrowser
'   starts (or reuses) the server but does not open the browser.
Option Explicit

Dim sh, fso, base, py, portFile, port, i, tf, xhr, alive, noBrowser

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

noBrowser = False
For i = 0 To WScript.Arguments.Count - 1
    If LCase(WScript.Arguments(i)) = "/nobrowser" Then noBrowser = True
Next

base = fso.GetParentFolderName(WScript.ScriptFullName)
portFile = base & "\port.txt"
port = "8899"

' ---- 1. is a server already running? ask it ----
alive = False
If fso.FileExists(portFile) Then
    Set tf = fso.OpenTextFile(portFile, 1)
    port = Trim(tf.ReadLine())
    tf.Close
    On Error Resume Next
    Set xhr = CreateObject("MSXML2.XMLHTTP")
    If Err.Number <> 0 Then
        Err.Clear
        Set xhr = CreateObject("MSXML.XMLHTTP")
    End If
    xhr.open "GET", "http://127.0.0.1:" & port & "/__ping", False
    xhr.send ""
    If Err.Number = 0 Then
        If xhr.status = 200 Then alive = True
    End If
    Err.Clear
    On Error GoTo 0
End If

' ---- 2. start it only when nobody answers ----
If Not alive Then
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
    For i = 1 To 20
        WScript.Sleep 250
        If fso.FileExists(portFile) Then
            Set tf = fso.OpenTextFile(portFile, 1)
            port = Trim(tf.ReadLine())
            tf.Close
            Exit For
        End If
    Next
End If

If noBrowser Then
    WScript.Quit 0
End If
sh.Run "http://127.0.0.1:" & port & "/"
