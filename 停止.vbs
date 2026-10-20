' ============ Stopper (double-click to run) ============
' POSTs /__shutdown to the server started by the launcher. No window shown.
' NOTE: keep this file pure ASCII (see note in the launcher).
Option Explicit

Dim sh, fso, base, portFile, port, tf, xhr

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)

portFile = base & "\port.txt"
port = "8899"
If fso.FileExists(portFile) Then
    Set tf = fso.OpenTextFile(portFile, 1)
    port = Trim(tf.ReadLine())
    tf.Close
End If

On Error Resume Next
Set xhr = CreateObject("MSXML.XMLHTTP")
xhr.open "POST", "http://127.0.0.1:" & port & "/__shutdown", False
xhr.send ""
If Err.Number <> 0 Then
    sh.Popup "Cannot reach the server (it may already be stopped).", 3, "ES Replay", 48
End If
On Error GoTo 0
