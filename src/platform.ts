import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

export function isOwnedByCurrentUser(stat: Pick<Stats, 'uid'>): boolean {
  if (IS_WINDOWS) return true;
  return stat.uid === process.getuid?.();
}

export function getDefaultStateDir(home = homedir()): string {
  if (IS_WINDOWS) {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'GravityBox');
  }
  return join(home, 'Library', 'Application Support', 'GravityBox');
}

export function getDefaultCacheDir(home = homedir()): string {
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'GravityBox', 'Cache');
  }
  return join(home, 'Library', 'Caches', 'GravityBox');
}

export function getDefaultAppSupportDir(home = homedir()): string {
  if (IS_WINDOWS) {
    return process.env.APPDATA || join(home, 'AppData', 'Roaming');
  }
  return join(home, 'Library', 'Application Support');
}

export function getDefaultApplicationsDir(home = homedir()): string {
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs');
  }
  return '/Applications';
}

export function getDefaultTrashDir(home = homedir()): string {
  if (IS_WINDOWS) {
    return join(getDefaultCacheDir(home), 'maintenance-trash');
  }
  return join(home, '.Trash');
}

export function isNamedPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\');
}

export function getIpcEndpoint(stateDir: string): string {
  if (IS_WINDOWS) {
    const digest = createHash('sha256').update(resolve(stateDir).toLowerCase()).digest('hex').slice(0, 20);
    return `\\\\.\\pipe\\gravitybox-${digest}`;
  }
  return join(stateDir, 'control.sock');
}

export function getAppResourcesDir(appPath: string): string {
  if (appPath.endsWith('.app') || existsSync(join(appPath, 'Contents', 'Resources'))) {
    return join(appPath, 'Contents', 'Resources');
  }
  if (IS_WINDOWS || existsSync(join(appPath, 'resources'))) {
    return join(appPath, 'resources');
  }
  return join(appPath, 'Contents', 'Resources');
}

export function getAppAsarPath(appPath: string): string {
  return join(getAppResourcesDir(appPath), 'app.asar');
}

export function getAppExecutablePath(appPath: string, executableName = 'Antigravity'): string {
  if (appPath.endsWith('.app') || existsSync(join(appPath, 'Contents', 'MacOS'))) {
    return join(appPath, 'Contents', 'MacOS', executableName);
  }
  if (IS_WINDOWS) {
    const exe = executableName.toLowerCase().endsWith('.exe') ? executableName : `${executableName}.exe`;
    return join(appPath, exe);
  }
  return join(appPath, 'Contents', 'MacOS', executableName);
}

export function getLanguageServerPath(appPath: string): string {
  if (appPath.endsWith('.app') || existsSync(join(appPath, 'Contents', 'Resources'))) {
    return join(appPath, 'Contents', 'Resources', 'bin', 'language_server');
  }
  if (IS_WINDOWS) {
    return join(appPath, 'resources', 'bin', 'language_server.exe');
  }
  return join(appPath, 'Contents', 'Resources', 'bin', 'language_server');
}

export function normalizePathForCompare(filePath: string): string {
  const normalized = resolve(filePath).replaceAll('\\', '/');
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

export function pathStartsWith(candidatePath: string, prefixPath: string): boolean {
  const cleanCandidate = candidatePath.trim().replace(/^"(.*)"$/, '$1').replaceAll('\\', '/');
  const cleanPrefix = prefixPath.trim().replace(/^"(.*)"$/, '$1').replaceAll('\\', '/');
  if (IS_WINDOWS) {
    return cleanCandidate.toLowerCase().startsWith(cleanPrefix.toLowerCase());
  }
  return cleanCandidate.startsWith(cleanPrefix);
}

export function basenameCrossPlatform(filePath: string): string {
  return basename(filePath);
}

export interface WindowsProcessEntry {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

const WIN_PROC_CACHE_TTL_MS = 600;
let winProcCache: { at: number; list: WindowsProcessEntry[] } | null = null;
let winProcInFlight: Promise<WindowsProcessEntry[]> | null = null;

export async function readWindowsProcesses(force = false): Promise<WindowsProcessEntry[]> {
  if (!IS_WINDOWS) return [];
  const now = Date.now();
  if (!force && winProcCache && now - winProcCache.at < WIN_PROC_CACHE_TTL_MS) {
    return winProcCache.list;
  }
  if (!force && winProcInFlight) {
    return winProcInFlight;
  }
  const task = (async (): Promise<WindowsProcessEntry[]> => {
    try {
      const psScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$items = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath, CommandLine',
        'ConvertTo-Json -InputObject @($items) -Compress',
      ].join('; ');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 6000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
      );
      const raw = stdout.trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const list: WindowsProcessEntry[] = [];
      for (const row of rows) {
        const pid = Number(row?.ProcessId);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        list.push({
          pid,
          name: typeof row?.Name === 'string' ? row.Name : '',
          executablePath: typeof row?.ExecutablePath === 'string' ? row.ExecutablePath : '',
          commandLine: typeof row?.CommandLine === 'string' ? row.CommandLine : '',
        });
      }
      winProcCache = { at: Date.now(), list };
      return list;
    } catch {
      return [];
    }
  })();
  winProcInFlight = task;
  try {
    return await task;
  } finally {
    if (winProcInFlight === task) winProcInFlight = null;
  }
}

export async function readWindowsListeningPorts(): Promise<Array<{ pid: number; address: string; port: number }>> {
  if (!IS_WINDOWS) return [];
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'TCP'], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const results: Array<{ pid: number; address: string; port: number }> = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('TCP')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddr = parts[1] ?? '';
      const state = (parts[3] ?? '').toUpperCase();
      const pid = Number(parts[4]);
      if (state !== 'LISTENING' || !Number.isSafeInteger(pid) || pid <= 0) continue;
      const lastColon = localAddr.lastIndexOf(':');
      if (lastColon <= 0) continue;
      const host = localAddr.slice(0, lastColon);
      const port = Number(localAddr.slice(lastColon + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      results.push({ pid, address: `${host}:${port}`, port });
    }
    return results;
  } catch {
    return [];
  }
}

const WIN_CRED_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class GravityBoxWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, int flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    public static string ReadSecret(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return "MISSING";
            throw new Exception("CredRead failed: " + err);
        }
        try {
            var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
            byte[] bytes = new byte[cred.CredentialBlobSize];
            if (cred.CredentialBlobSize > 0) Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            return "FOUND:" + Convert.ToBase64String(bytes);
        } finally {
            CredFree(ptr);
        }
    }

    public static void WriteSecret(string target, string userName, string base64Secret) {
        byte[] bytes = Convert.FromBase64String(base64Secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            if (bytes.Length > 0) Marshal.Copy(bytes, 0, blob, bytes.Length);
            var cred = new CREDENTIAL {
                Type = 1,
                TargetName = target,
                UserName = userName,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = 2
            };
            if (!CredWrite(ref cred, 0)) {
                throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeHGlobal(blob);
        }
    }

    public static void DeleteSecret(string target) {
        if (!CredDelete(target, 1, 0)) {
            int err = Marshal.GetLastWin32Error();
            if (err != 1168) throw new Exception("CredDelete failed: " + err);
        }
    }
}
`;

function runWinCredPowerShell(payload: Record<string, string>, timeoutMs = 8000): Promise<string> {
  return new Promise((resolveOut, rejectOut) => {
    const script = [
      '$inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json',
      `Add-Type -TypeDefinition @'\n${WIN_CRED_CSHARP}\n'@`,
      'switch ($inputJson.op) {',
      '  "read"   { Write-Output ([GravityBoxWinCred]::ReadSecret($inputJson.target)) }',
      '  "write"  { [GravityBoxWinCred]::WriteSecret($inputJson.target, $inputJson.user, $inputJson.b64); Write-Output "OK" }',
      '  "delete" { [GravityBoxWinCred]::DeleteSecret($inputJson.target); Write-Output "OK" }',
      '  default  { throw "Unsupported op" }',
      '}',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (err?: Error, out = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectOut(err);
      else resolveOut(out.trim());
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('Windows Credential Manager operation timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.on('error', err => finish(err));
    child.on('close', code => {
      if (code === 0) finish(undefined, stdout);
      else finish(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function winCredRead(service: string, account: string): Promise<string | null> {
  const target = `${service}:${account}`;
  const out = await runWinCredPowerShell({ op: 'read', target });
  if (out === 'MISSING') return null;
  if (out.startsWith('FOUND:')) {
    const bytes = Buffer.from(out.slice('FOUND:'.length), 'base64');
    return bytes.toString('utf8') || null;
  }
  return null;
}

export async function winCredWrite(service: string, account: string, password: string): Promise<void> {
  const target = `${service}:${account}`;
  const b64 = Buffer.from(password, 'utf8').toString('base64');
  await runWinCredPowerShell({ op: 'write', target, user: account, b64 });
}

export async function winCredDelete(service: string, account: string): Promise<void> {
  const target = `${service}:${account}`;
  await runWinCredPowerShell({ op: 'delete', target });
}
