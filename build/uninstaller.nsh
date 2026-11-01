; 卸载时询问是否删除用户配置与缓存。
; 宏名必须是 customUnInstall —— electron-builder 的卸载 Section 只插入这个宏，
; 旧的 preUninstall 在模板里没有任何调用点，属于从不执行的死代码。
!macro customUnInstall
  ; 自动更新（--updated）与静默卸载（/S）一律不弹框、不动用户数据，否则更新会卡在询问框上
  ${ifNot} ${isUpdated}
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除你的配置、API Key 和缓存数据？$\n$\n选「是」：彻底卸载，下次安装像全新软件一样。$\n选「否」：只删程序，保留配置，下次安装直接恢复。" IDNO KeepData

      ; 真正的配置目录：main.js 里 APP_DIR = os.homedir() + "\.douyin-knowledge-app"
      ; settings.json、API Key、Whisper 模型、转录缓存都在这里
      RMDir /r "$PROFILE\.douyin-knowledge-app"

      ; Electron 运行时数据：userData 下的 updater\app-update.yml、Cache、GPUCache
      RMDir /r "$APPDATA\douyin-knowledge-app"

      ; 历史版本可能建过的同名目录，存在就清，不存在不报错
      RMDir /r "$LOCALAPPDATA\douyin-knowledge-app"

      ; 自动更新下载缓存，单份约 900MB
      RMDir /r "$LOCALAPPDATA\douyin-knowledge-app-updater"

      KeepData:
    ${EndIf}
  ${EndIf}
!macroend
