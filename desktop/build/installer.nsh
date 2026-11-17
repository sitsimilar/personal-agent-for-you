; ---------------------------------------------------------------------------
; 补全「设置 → 应用」/「控制面板 → 程序和功能」以及第三方软件管理器读取的元数据。
;
; 背景（2026-11-16 排查「装完系统检测不到」）：
;   electron-builder 的 NSIS 模板（include/installer.nsh → registryAddInstallInfo）
;   只把 InstallLocation 写进 Software\<GUID> 这个「自己用」的键，
;   Uninstall\<GUID> 里没有；Publisher 仅在 COMPANY_NAME 存在时才写；
;   InstallDate 从不写；DisplayIcon 因为配了 nsis.uninstallerIcon 而指向
;   uninstallerIcon.ico 而不是主程序。
;
;   而绝大多数安装扫描器（Windows 的 ARP 枚举、各类软件管家/启动器/资产管理工具）
;   判断「这软件装在哪」读的就是 Uninstall\<GUID>\InstallLocation。缺这一项，
;   要么整条记录被过滤掉，要么显示成「未知路径」——用户看到的就是"系统检测不到"。
;
; 执行时机：installSection.nsh 第 67 行 insertmacro registryAddInstallInfo 之后、
; 第 82 行 insertmacro customInstall —— 所以这里写的是最终值，不会被模板覆盖。
;
; 注意：本文件全部用英文注释。makensis 对非 BOM 的 UTF-8 中文注释会按本地
; 代码页解析，容易在 CI/别的机器上炸；脚本里也不要硬编码中文路径，
; 一律走 electron-builder 提供的宏变量。
; ---------------------------------------------------------------------------

; InstallDate 用打包时刻（yyyyMMdd）。NSIS 没有内置的运行时取日期语句，
; 用 System::Call 取 GetLocalTime 会引入一堆寄存器操作，收益不抵复杂度；
; 安装包通常是当天打包当天装，编译期日期足够准确。
!define /date PA_INSTALL_DATE "%Y%m%d"
!define PA_APP_URL "https://personal-agent-08495.app.workbuddy.link/welcome/"

!macro customInstall
  ; 0) 发布者。模板只在 COMPANY_NAME 有值时才写（该值默认取 package.json 的
  ;    author.name）；这里兜底，避免哪天 author 被删掉后「发布者」又变空白。
  !ifndef COMPANY_NAME
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Personal Agent"
  !endif

  ; 1) 安装目录 —— 缺这一项是「检测不到」的主因
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"

  ; 2) 图标指回主程序。模板因 nsis.uninstallerIcon 存在而写成 uninstallerIcon.ico，
  ;    那个 .ico 只是 NSIS 生成卸载器时的中间产物，一旦被清理，应用图标就会裂。
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"

  ; 3) 安装日期与帮助链接（模板完全不写这两个）
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallDate" "${PA_INSTALL_DATE}"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout" "${PA_APP_URL}"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "URLUpdateInfo" "${PA_APP_URL}"

  ; 4) App Paths：Win+R 直接输入 exe 名、启动器与自动化工具按名定位程序都读这里。
  ;    桌面应用不需要进 PATH（那是给命令行工具的），App Paths 才是 Windows 的标准入口。
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"
!macroend

; 卸载时把 App Paths 一并清掉，否则残留一个指向空目录的项，
; Win+R 会弹「找不到文件」。
!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
!macroend
