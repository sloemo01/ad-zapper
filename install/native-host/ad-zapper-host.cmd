@echo off
rem Chrome starts this on Windows for the update button. It only forwards the
rem framed request on stdin to the Python host, which does the real work.
py -3 "%~dp0ad-zapper-host.py" 2>nul || python "%~dp0ad-zapper-host.py"
