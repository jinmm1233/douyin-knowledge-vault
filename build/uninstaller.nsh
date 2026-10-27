!macro preUninstall
  ; 询问用户是否同时删除配置和数据
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除你的配置、API Key 和缓存数据？$\n$\n选「是」：彻底卸载，下次安装像全新软件一样。$\n选「否」：只删程序，保留配置，下次安装直接恢复。" IDNO KeepData
    RMDir /r "$APPDATA\douyin-knowledge-app"
    RMDir /r "$LOCALAPPDATA\douyin-knowledge-app"
  KeepData:
!macroend
