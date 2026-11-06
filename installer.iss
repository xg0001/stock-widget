; 股票自选小窗 Inno Setup 安装包脚本
#define MyAppName "股票自选小窗"
#define MyAppVersion "1.0.0"
#define MyAppExeName "股票自选小窗.exe"

[Setup]
AppId={{7C6E1D52-8F4A-4B9E-9D3A-2E5C8B1F0A64}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
; 免管理员权限：装到用户目录，普通用户一路下一步即可
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#MyAppName}
DisableDirPage=no
DisableProgramGroupPage=yes
OutputDir=release
OutputBaseFilename=股票自选小窗-Setup-{#MyAppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "chinesesimplified"; MessagesFile: "D:\Program Files\Inno Setup 7\Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式(&D)"; GroupDescription: "附加图标："

[Files]
Source: "release\股票自选小窗-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 用户数据（AppData\Roaming\stock-ticker-widget）有意保留，卸载重装不丢自选股
