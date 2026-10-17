/**
 * Client half of the Turn Complete Toast bundle.
 *
 * Reports the end of the turn running in the conversation currently open in
 * the main view, in the spirit of Codex's completion notice. Three channels,
 * each controlled from the plugin's own configuration page:
 *
 *  - In-app toast (bottom-right of the page, the overlay layer).
 *  - System notification (Windows notification centre, screen bottom-right).
 *  - A short chime synthesised with the Web Audio API.
 *
 * Turn signals, strongest first:
 *  - The durable `turn/end` event of that session (`ctx.sessions.binding(id)
 *    .eventSource`), whose `reason.kind` separates a real completion from an
 *    abort, an agent error, and a length-limit stop.
 *  - The session status `running` flag as a fallback, so a client build that
 *    cannot hand us an event source still reports completion.
 *
 * Settings persist as a first-party cookie (ports may change between runs,
 * so `localStorage` alone would lose them) mirrored into `localStorage`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-interaction-optimize',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-interaction-optimize';
    const ROW_CONFIG_KEY = 'dsh-interaction-optimize#dsh-interaction-optimize';
    /** A precise `turn/end` reading suppresses the running-flag fallback for this long. */
    const PRECISE_DEDUPE_MS = 2500;
    const MAX_DETAIL_CHARS = 160;
    /** Kept from the pre-rename plugin so existing settings survive the rename. */
    const SETTINGS_COOKIE = 'codex_like';
    const SETTINGS_STORAGE = 'codex-like.settings';
    const SOUND_ROUTE = '/dsh-interaction-optimize/sound';
    const CHANGES_ROUTE = '/dsh-interaction-optimize/changes';
    const MAX_SOUND_BYTES = 4 * 1024 * 1024;
    /** Poll cadence for the diff badge while a turn is running. */
    const CHANGES_POLL_MS = 1200;
    /** Slower cadence while idle, so a summary recorded just after turn end still lands. */
    const CHANGES_IDLE_POLL_MS = 5000;

    const TONE_BY_KIND = {
      completed: 'success',
      error: 'error',
      'max-tokens': 'warning',
    };

    const DEFAULT_SETTINGS = {
      inAppToast: true,
      diffBadge: true,
      fileMenu: true,
      sound: true,
      soundSource: 'chime',
      soundVersion: 0,
      soundName: '',
      holdSeconds: 6,
      systemNotify: 'hidden',
    };

    /** System-notification modes; the order is the settings-page order. */
    const SYSTEM_MODES = ['off', 'hidden', 'always'];

    /** Selectable auto-dismiss delays in seconds; `0` keeps the toast until dismissed. */
    const HOLD_OPTIONS = [3, 5, 6, 8, 12, 20, 30, 0];

    const ZH = {
      'toast.completed': '本轮执行完成',
      'toast.error': '本轮执行失败',
      'toast.maxTokens': '本轮输出已达上限',
      'toast.close': '关闭提示',
      'diff.added': '新增行',
      'diff.deleted': '删除行',
      'diff.files': '个文件',
      'diff.filesChangedOne': '个文件已更改',
      'diff.filesChangedMany': '个文件已更改',
      'diff.openReview': '在侧边栏查看本轮改动',
      'diff.binary': '二进制',
      'diff.oversized': '过大',
      'anno.add': '添加到对话',
      'anno.title': '添加注释',
      'anno.quoteLabel': '所选文本：',
      'anno.commentLabel': '用户评论：',
      'anno.edit': '编辑注释',
      'anno.clear': '清空注释',
      'anno.placeholder': '添加你的注释…',
      'anno.cancel': '取消',
      'anno.save': '保存',
      'anno.delete': '删除注释',
      'anno.count': '条注释',
      'settings.inApp.title': '应用内提示框',
      'settings.inApp.desc': '在 DSH 页面右下角显示完成提示卡片，并带上一小段本次回复的内容。',
      'settings.system.title': '系统通知',
      'settings.system.desc': '窗口可见时用应用内卡片（本插件样式）；只有窗口不可见/最小化时才弹系统通知，其外观由操作系统决定。',
      'settings.system.off': '关闭',
      'settings.system.hidden': '仅窗口不可见时',
      'settings.system.always': '每次完成都弹出',
      'settings.system.permission.granted': '系统通知已授权。',
      'settings.system.permission.default': '系统通知尚未授权，需要手动允许一次。',
      'settings.system.permission.denied': '系统通知已被拒绝，请在系统设置里允许后重试。',
      'settings.system.permission.unsupported': '当前环境不支持系统通知。',
      'settings.system.permission.enable': '启用系统通知',
      'settings.diffBadge.title': '输入框上方增删统计',
      'settings.diffBadge.desc': '在输入框上方显示本轮代码改动的新增/删除行数与文件数。',
      'settings.fileMenu.title': '文件右键菜单',
      'settings.fileMenu.desc': '在对话里右键文件链接：用默认应用打开、显示文件位置，或选择其他应用。',
      'fileMenu.open': '用默认应用打开',
      'fileMenu.reveal': '显示文件位置',
      'fileMenu.other': '其他应用打开…',
      'fileMenu.loading': '正在获取应用…',
      'fileMenu.noApps': '没有可用的应用',
      'fileMenu.failed': '打开失败',
      'fileMenu.back': '返回',
      'fileMenu.default': '默认',
      'settings.hold.title': '显示时长',
      'settings.hold.desc': '提示框自动消失前停留的时间；选「一直显示」则需手动关闭或等下一轮开始。',
      'settings.hold.seconds': '秒',
      'settings.hold.never': '一直显示',
      'settings.sound.title': '提示音',
      'settings.sound.desc': '本轮完成时播放提示音。',
      'settings.sound.preview': '试听',
      'settings.sound.sourceTitle': '自定义提示音',
      'settings.sound.sourceDesc': '使用内置提示音，或上传一段自己的音频文件。',
      'settings.sound.builtin': '内置提示音',
      'settings.sound.custom': '自定义音频',
      'settings.sound.choose': '选择音频文件…',
      'settings.sound.none': '尚未选择文件',
      'settings.sound.current': '当前文件：',
      'settings.sound.uploading': '正在上传…',
      'settings.sound.uploadFailed': '上传失败：Host 半边可能还没加载，重启一次 DSH 后重试。',
      'settings.sound.invalid': '请选择音频文件（wav / mp3 / ogg / m4a / webm）。',
      'settings.sound.tooBig': '音频文件不能超过 4 MB。',
      'settings.sound.remove': '恢复内置',
      'settings.previewToast': '预览提示框',
      'settings.previewSample': '预览：本轮完成后，这里会显示回复的节选。',
    };

    const EN = {
      'toast.completed': 'Turn complete',
      'toast.error': 'Turn failed',
      'toast.maxTokens': 'Output limit reached',
      'toast.close': 'Dismiss',
      'diff.added': 'Added lines',
      'diff.deleted': 'Deleted lines',
      'diff.files': 'files',
      'diff.filesChangedOne': 'file changed',
      'diff.filesChangedMany': 'files changed',
      'diff.openReview': "Open this turn's changes",
      'diff.binary': 'binary',
      'diff.oversized': 'too large',
      'anno.add': 'Add to conversation',
      'anno.title': 'Add a comment',
      'anno.quoteLabel': 'Selected text:',
      'anno.commentLabel': 'Comment:',
      'anno.edit': 'Edit comment',
      'anno.clear': 'Clear comments',
      'anno.placeholder': 'Add your comment…',
      'anno.cancel': 'Cancel',
      'anno.save': 'Save',
      'anno.delete': 'Delete comment',
      'anno.count': 'comments',
      'settings.inApp.title': 'In-app toast',
      'settings.inApp.desc': 'Show a completion card at the bottom-right of the DSH page, with a short excerpt of the reply.',
      'settings.system.title': 'System notification',
      'settings.system.desc': 'The in-app card is used while the window is visible; the OS toast only fires while the window is hidden or minimized, and its look is controlled by the OS.',
      'settings.system.off': 'Off',
      'settings.system.hidden': 'Only when the window is hidden',
      'settings.system.always': 'On every completion',
      'settings.system.permission.granted': 'System notifications are allowed.',
      'settings.system.permission.default': 'System notifications need one-time permission.',
      'settings.system.permission.denied': 'System notifications were denied; allow them in system settings and retry.',
      'settings.system.permission.unsupported': 'This environment does not support system notifications.',
      'settings.system.permission.enable': 'Allow system notifications',
      'settings.diffBadge.title': 'Diff badge above the composer',
      'settings.diffBadge.desc': 'Show this turn\'s added/deleted line counts and changed file count above the input box.',
      'settings.fileMenu.title': 'File context menu',
      'settings.fileMenu.desc': 'Right-click a file link in the conversation to open it with the default app, reveal it in the file manager, or pick another app.',
      'fileMenu.open': 'Open with default app',
      'fileMenu.reveal': 'Show file location',
      'fileMenu.other': 'Open with another app…',
      'fileMenu.loading': 'Loading applications…',
      'fileMenu.noApps': 'No applications available',
      'fileMenu.failed': 'Could not open',
      'fileMenu.back': 'Back',
      'fileMenu.default': 'Default',
      'settings.hold.title': 'Display time',
      'settings.hold.desc': 'How long the toast stays before it hides itself; choose "Keep showing" to dismiss it manually.',
      'settings.hold.seconds': 's',
      'settings.hold.never': 'Keep showing',
      'settings.sound.title': 'Sound',
      'settings.sound.desc': 'Play a sound when a turn finishes.',
      'settings.sound.preview': 'Preview',
      'settings.sound.sourceTitle': 'Custom sound',
      'settings.sound.sourceDesc': 'Use the built-in chime, or upload your own audio file.',
      'settings.sound.builtin': 'Built-in chime',
      'settings.sound.custom': 'Custom audio',
      'settings.sound.choose': 'Choose audio file…',
      'settings.sound.none': 'No file chosen yet',
      'settings.sound.current': 'Current file: ',
      'settings.sound.uploading': 'Uploading…',
      'settings.sound.uploadFailed': 'Upload failed: the host half may not be loaded yet; restart DSH and retry.',
      'settings.sound.invalid': 'Choose an audio file (wav / mp3 / ogg / m4a / webm).',
      'settings.sound.tooBig': 'The audio file must be 4 MB or smaller.',
      'settings.sound.remove': 'Back to built-in',
      'settings.previewToast': 'Preview toast',
      'settings.previewSample': 'Preview: when a turn finishes, the reply excerpt shows here.',
    };

    const CSS = [
      '.dsh-tct-layer{position:fixed;right:20px;bottom:20px;z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none}',
      '.dsh-tct-card{pointer-events:auto;box-sizing:border-box;display:flex;align-items:flex-start;gap:10px;width:max-content;min-width:240px;max-width:min(380px,calc(100vw - 40px));padding:12px 10px 12px 14px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);animation:dsh-tct-in 180ms cubic-bezier(.2,.8,.2,1)}',
      '.dsh-tct-icon{display:flex;flex:0 0 auto;align-items:center;justify-content:center;width:20px;height:20px;margin-top:1px;color:var(--dsw-alias-state-success-primary)}',
      '.dsh-tct-card[data-tone="error"] .dsh-tct-icon{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-tct-card[data-tone="warning"] .dsh-tct-icon{color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-tct-body{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}',
      '.dsh-tct-title{font-size:13px;font-weight:600;line-height:18px}',
      '.dsh-tct-detail{display:block;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tct-close{display:flex;flex:0 0 auto;align-items:center;justify-content:center;width:20px;height:20px;margin:-2px 0 0 0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}',
      '.dsh-tct-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-tct-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-tct-settings{display:flex;flex-direction:column;gap:16px;max-width:560px;color:var(--dsw-alias-label-primary)}',
      '.dsh-tct-setting{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dsh-tct-settingText{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-tct-settingTitle{font-size:13px;font-weight:600;line-height:18px}',
      '.dsh-tct-settingDesc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tct-settingControl{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding-top:2px}',
      '.dsh-tct-checkbox{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dsh-tct-select{font:inherit;font-size:12px;line-height:16px;padding:4px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsh-tct-button{font:inherit;font-size:12px;line-height:16px;padding:5px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color 120ms ease}',
      '.dsh-tct-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-tct-button:disabled{opacity:.5;cursor:default}',
      '.dsh-tct-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-tct-hint{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cl-diff{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,952px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto;padding:0 var(--dsh-composer-dock-inset,8px);display:flex;align-items:center;justify-content:center;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);user-select:none}',
      '.dsh-cl-anchor{position:relative;display:inline-flex}',
      '.dsh-cl-pop-wrap{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);z-index:30;width:min(360px,calc(100vw - 24px));padding-bottom:8px}',
      '.dsh-cl-pop{box-sizing:border-box;max-height:320px;overflow-y:auto;padding:6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px}',
      '.dsh-cl-file{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default}',
      'button.dsh-cl-file{cursor:pointer}',
      'button.dsh-cl-file:hover{background:var(--dsw-alias-bg-layer-2)}',
      'button.dsh-cl-file:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsh-cl-file-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-cl-file-counts{display:inline-flex;flex:0 0 auto;gap:6px;font-variant-numeric:tabular-nums}',
      '.dsh-cl-file-add{color:var(--dsw-alias-state-success-primary);font-weight:600}',
      '.dsh-cl-file-del{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.dsh-cl-file-note{color:var(--dsw-alias-label-secondary)}',
      '.dsh-cl-anno-menu{position:fixed;z-index:60;display:flex;padding:3px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}',
      '.dsh-cl-anno-menu[hidden],.dsh-cl-anno-editor[hidden]{display:none!important}',
      '.dsh-cl-anno-menu button{min-height:28px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer}',
      '.dsh-cl-anno-menu button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cl-anno-marker{position:fixed;z-index:55;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:#1683f3;color:#fff;font-family:inherit;font-size:11px;font-weight:600;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.28);cursor:pointer}',
      '.dsh-cl-anno-marker[hidden]{display:none!important}',
      '.dsh-cl-anno-editor{position:fixed;z-index:60;display:flex;align-items:center;gap:6px;box-sizing:border-box;width:360px;padding:6px 6px 6px 16px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.dsh-cl-anno-input{flex:1 1 auto;min-width:0;border:0;outline:none;background:transparent;color:inherit;font-family:inherit;font-size:13px;line-height:20px}',
      '.dsh-cl-anno-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.dsh-cl-anno-check{flex:0 0 auto;display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:14px;line-height:1;cursor:pointer}',
      '.dsh-cl-anno-check:hover{opacity:.88}',
      '.dsh-cl-anno-dock{position:relative;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,952px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto;padding:0 var(--dsh-composer-dock-inset,8px);display:flex;justify-content:flex-start;font-size:12px;line-height:16px}',
      '.dsh-cl-anno-anchor{position:relative;display:inline-flex}',
      '.dsh-cl-anno-pill{display:inline-flex;align-items:center;gap:2px;padding:2px 4px 2px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-cl-anno-pill:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cl-anno-summary{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0;border:0;background:transparent;color:inherit;font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dsh-cl-anno-summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
      '.dsh-cl-anno-clear{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:pointer}',
      '.dsh-cl-anno-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-cl-anno-icon{display:inline-flex;align-items:center;justify-content:center}',
      '.dsh-cl-anno-pop-wrap{position:absolute;bottom:100%;left:0;z-index:30;width:min(440px,calc(100vw - 24px));padding-bottom:8px}',
      '.dsh-cl-anno-pop{box-sizing:border-box;max-height:320px;overflow:auto;padding:6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dsh-cl-anno-row{display:flex;align-items:flex-start;gap:8px;padding:8px}',
      '.dsh-cl-anno-row+.dsh-cl-anno-row{border-top:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-cl-anno-index{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-cl-anno-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh-cl-anno-label{margin-top:4px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-cl-anno-rowquote{white-space:pre-wrap;color:var(--dsw-alias-label-primary)}',
      '.dsh-cl-anno-comment{white-space:pre-wrap;color:var(--dsw-alias-label-primary)}',
      '.dsh-cl-anno-rowActions{display:flex;flex:0 0 auto;gap:2px}',
      '.dsh-cl-anno-iconbutton{width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:pointer}',
      '.dsh-cl-anno-iconbutton:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-cl-sent-anno{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:2px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dsh-cl-sent-anno:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cl-file-menu{position:fixed;z-index:70;box-sizing:border-box;min-width:210px;max-width:min(340px,calc(100vw - 16px));padding:5px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px}',
      '.dsh-cl-file-menu-title{padding:5px 9px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dsh-cl-file-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:0;border-radius:6px;background:transparent;color:inherit;font-family:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}',
      '.dsh-cl-file-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-cl-file-menu-item:disabled{opacity:.55;cursor:default}',
      '.dsh-cl-file-menu-item:disabled:hover{background:transparent}',
      '.dsh-cl-file-menu-icon{display:inline-flex;flex:0 0 16px;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1}',
      '.dsh-cl-file-menu-icon img{width:16px;height:16px;border-radius:3px;object-fit:contain}',
      '.dsh-cl-file-menu-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-cl-sent-pop{position:fixed;z-index:60;box-sizing:border-box;width:min(448px,calc(100vw - 24px));max-height:320px;overflow:auto;padding:6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px}',
      '.dsh-cl-pill{display:inline-flex;align-items:center;gap:8px;padding:3px 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}',
      'button.dsh-cl-pill{font-family:inherit;font-weight:400;cursor:pointer;transition:background-color 120ms ease}',
      'button.dsh-cl-pill:hover{background:var(--dsw-alias-bg-layer-2)}',
      'button.dsh-cl-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-cl-add{color:var(--dsw-alias-state-success-primary);font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsh-cl-del{color:var(--dsw-alias-state-error-primary);font-weight:600;font-variant-numeric:tabular-nums}',
      '@keyframes dsh-tct-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.dsh-tct-card{animation:none}}',
    ].join('');

    // ------------------------------------------------------------------
    // Settings: cookie first (survives a port change), localStorage mirror.
    // ------------------------------------------------------------------

    function normalizeSettings(raw) {
      const value = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        inAppToast: typeof value.inAppToast === 'boolean' ? value.inAppToast : DEFAULT_SETTINGS.inAppToast,
        diffBadge: typeof value.diffBadge === 'boolean' ? value.diffBadge : DEFAULT_SETTINGS.diffBadge,
        fileMenu: typeof value.fileMenu === 'boolean' ? value.fileMenu : DEFAULT_SETTINGS.fileMenu,
        sound: typeof value.sound === 'boolean' ? value.sound : DEFAULT_SETTINGS.sound,
        soundSource: value.soundSource === 'custom' ? 'custom' : 'chime',
        soundVersion: Number.isFinite(value.soundVersion) ? value.soundVersion : 0,
        soundName: typeof value.soundName === 'string' ? value.soundName : '',
        holdSeconds:
          Number.isFinite(value.holdSeconds) && value.holdSeconds >= 0
            ? Math.min(120, Math.round(value.holdSeconds))
            : DEFAULT_SETTINGS.holdSeconds,
        systemNotify: SYSTEM_MODES.includes(value.systemNotify === 'unfocused' ? 'hidden' : value.systemNotify)
          ? value.systemNotify === 'unfocused'
            ? 'hidden'
            : value.systemNotify
          : DEFAULT_SETTINGS.systemNotify,
      };
    }

    function readCookieSettings() {
      try {
        if (typeof document === 'undefined' || typeof document.cookie !== 'string') return undefined;
        const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + SETTINGS_COOKIE + '=([^;]*)'));
        if (match === null) return undefined;
        return JSON.parse(decodeURIComponent(match[1]));
      } catch {
        return undefined;
      }
    }

    function readLocalSettings() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return undefined;
        const raw = window.localStorage.getItem(SETTINGS_STORAGE);
        return raw === null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    }

    function writeSettings(settings) {
      const json = JSON.stringify(settings);
      try {
        document.cookie = `${SETTINGS_COOKIE}=${encodeURIComponent(json)}; path=/; max-age=31536000; SameSite=Lax`;
      } catch {
        /* cookies unavailable */
      }
      try {
        window.localStorage.setItem(SETTINGS_STORAGE, json);
      } catch {
        /* storage unavailable */
      }
    }

    let currentSettings = normalizeSettings(readCookieSettings() ?? readLocalSettings());
    const settingsListeners = new Set();

    function getSettings() {
      return currentSettings;
    }

    function subscribeSettings(listener) {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    }

    function updateSettings(patch) {
      const next = normalizeSettings({ ...currentSettings, ...patch });
      if (JSON.stringify(next) === JSON.stringify(currentSettings)) return;
      currentSettings = next;
      writeSettings(next);
      for (const listener of [...settingsListeners]) listener();
    }

    // ------------------------------------------------------------------
    // Sound: a two-note chime synthesised once, no asset download.
    // ------------------------------------------------------------------

    let audioContext;

    /** Create or resume the shared AudioContext; call from a user gesture when possible. */
    function ensureAudioContext() {
      const AudioCtor =
        typeof window === 'undefined' ? undefined : window.AudioContext || window.webkitAudioContext;
      if (typeof AudioCtor !== 'function') return undefined;
      audioContext = audioContext ?? new AudioCtor();
      if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
      return audioContext;
    }

    function playChime() {
      try {
        const context = ensureAudioContext();
        if (context === undefined) return;
        const now = context.currentTime;
        const notes = [
          [880, 0],
          [1318.51, 0.14],
        ];
        for (const [frequency, offset] of notes) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, now + offset);
          gain.gain.setValueAtTime(0.0001, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.5);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(now + offset);
          oscillator.stop(now + offset + 0.55);
        }
      } catch {
        /* audio unavailable or blocked by autoplay policy */
      }
    }

    /** Play the uploaded clip; fall back to the built-in chime when it cannot load. */
    function playCustomSound(version) {
      try {
        const audio = new Audio(`${SOUND_ROUTE}?v=${encodeURIComponent(String(version))}`);
        audio.volume = 0.7;
        const started = audio.play();
        if (started !== null && typeof started.catch === 'function') {
          started.catch(() => playChime());
        }
      } catch {
        playChime();
      }
    }

    /** Play whatever the current settings select. */
    function playSelectedSound() {
      const settings = getSettings();
      if (!settings.sound) return;
      if (settings.soundSource === 'custom') playCustomSound(settings.soundVersion);
      else playChime();
    }

    // ------------------------------------------------------------------
    // System notification (OS notification centre, screen bottom-right).
    // ------------------------------------------------------------------

    function notificationPermission() {
      try {
        return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      } catch {
        return 'unsupported';
      }
    }

    function pageHidden() {
      try {
        return typeof document !== 'undefined' && document.hidden === true;
      } catch {
        return false;
      }
    }

    function shouldNotifySystem(settings) {
      if (settings.systemNotify === 'off') return false;
      if (notificationPermission() !== 'granted') return false;
      // A visible window always gets the styled in-app card; the OS toast exists
      // only for the case the card cannot be seen at all.
      return settings.systemNotify === 'always' || pageHidden();
    }

    function showSystemNotification(title, body, tag) {
      try {
        if (notificationPermission() !== 'granted') return;
        const notification = new Notification(title, {
          body: body === undefined ? undefined : body,
          tag,
          silent: true,
          requireInteraction: false,
        });
        notification.onclick = () => {
          try {
            window.focus();
          } catch {
            /* focus may be refused outside a click handler on some platforms */
          }
        };
      } catch {
        /* permission or platform refused the notification */
      }
    }

    // ------------------------------------------------------------------
    // Toast preview bridge: the settings page can ask the overlay to show one.
    // ------------------------------------------------------------------

    const previewListeners = new Set();

    function subscribeToastPreview(listener) {
      previewListeners.add(listener);
      return () => {
        previewListeners.delete(listener);
      };
    }

    /**
     * Ask the overlay to show a sample notice.
     * @param holdSeconds - the display duration the caller's settings page shows.
     */
    function requestToastPreview(holdSeconds) {
      for (const listener of [...previewListeners]) listener(holdSeconds);
    }

    // ------------------------------------------------------------------
    // Pending annotations (Codex-style select-text comments).
    // ------------------------------------------------------------------

    /** Pending annotations for the open conversation; transient by design. */
    let annotations = [];
    let annotationsSessionId = undefined;
    let annotationSeq = 0;
    const annotationListeners = new Set();

    function annotationSnapshot() {
      return annotations;
    }

    function subscribeAnnotations(listener) {
      annotationListeners.add(listener);
      return () => {
        annotationListeners.delete(listener);
      };
    }

    function notifyAnnotations() {
      for (const listener of [...annotationListeners]) listener();
    }

    function addAnnotation(quote, comment, range) {
      annotationSeq += 1;
      annotations = [...annotations, { id: annotationSeq, quote, comment, range }];
      notifyAnnotations();
    }

    function updateAnnotation(id, comment) {
      annotations = annotations.map((note) => (note.id === id ? { ...note, comment } : note));
      notifyAnnotations();
    }

    function removeAnnotation(id) {
      annotations = annotations.filter((note) => note.id !== id);
      notifyAnnotations();
    }

    function clearAnnotations() {
      if (annotations.length === 0) return;
      annotations = [];
      notifyAnnotations();
    }

    /** Numbered badges pinned to the annotated text, like Codex's comment markers. */
    const annotationMarkers = new Map();

    function renderAnnotationMarkers() {
      if (typeof document === 'undefined') return;
      const live = new Set(annotations.map((note) => note.id));
      for (const [id, marker] of annotationMarkers) {
        if (!live.has(id)) {
          marker.remove();
          annotationMarkers.delete(id);
        }
      }
      annotations.forEach((note, index) => {
        let marker = annotationMarkers.get(note.id);
        if (marker === undefined) {
          marker = document.createElement('button');
          marker.type = 'button';
          marker.className = 'dsh-cl-anno-marker';
          marker.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent('dsh-interaction-optimize:annotations-open'));
          });
          document.body.appendChild(marker);
          annotationMarkers.set(note.id, marker);
        }
        marker.textContent = String(index + 1);
        marker.title = note.comment !== '' ? note.comment : note.quote;
        let rect;
        try {
          rect = note.range && typeof note.range.getBoundingClientRect === 'function' ? note.range.getBoundingClientRect() : undefined;
        } catch {
          rect = undefined;
        }
        if (rect === undefined || (!rect.width && !rect.height)) {
          marker.hidden = true;
          return;
        }
        marker.hidden = false;
        marker.style.left = `${Math.min(window.innerWidth - 26, rect.right + 4)}px`;
        marker.style.top = `${Math.max(8, rect.top - 10)}px`;
      });
    }

    function disposeAnnotationMarkers() {
      for (const marker of annotationMarkers.values()) marker.remove();
      annotationMarkers.clear();
    }

    /**
     * Sentinels delimiting the annotation block inside a sent message.
     * Visible, markdown-safe tokens: a renderer that drops invisible format
     * characters would make an invisible marker undetectable, so the fold uses
     * plain characters and hides them together with the block.
     */
    const ANNO_START = '〔codex-like-annotations〕';
    const ANNO_END = '〔/codex-like-annotations〕';
    /** Older blocks used invisible markers; keep recognizing them. */
    const ANNO_MARKERS = [
      { start: ANNO_START, end: ANNO_END },
      { start: '\u200b\u2063\u200b', end: '\u2063\u200b\u2063' },
    ];
    /** Invisible draft placeholder that keeps the composer's send control enabled. */
    const ANNOTATION_TOKEN = '\u2063';

    /** Render pending annotations as readable markdown the model can use. */
    function buildAnnotationBlock(list) {
      const entries = [];
      for (const note of list) {
        const quoted = String(note.quote)
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        const comment = typeof note.comment === 'string' && note.comment.trim() !== '' ? note.comment.trim() : '';
        entries.push(comment === '' ? quoted : `${quoted}\n\n注释：${comment}`);
      }
      // Blank lines between entries keep each annotation a separate paragraph,
      // which is what the fold parser (and the rendered markdown) splits on.
      return [ANNO_START, ...entries, ANNO_END].join('\n\n');
    }

    /** Locate the annotation block's markers in a plain-text rendering. */
    function findAnnotationMarkers(text) {
      for (const marker of ANNO_MARKERS) {
        const start = text.indexOf(marker.start);
        if (start < 0) continue;
        const end = text.indexOf(marker.end, start + marker.start.length);
        if (end < 0) continue;
        return { start, end, innerStart: start + marker.start.length, marker };
      }
      return undefined;
    }

    /** Parse the annotation block out of a sent message's plain text. */
    function parseSentAnnotations(text) {
      const found = findAnnotationMarkers(text);
      if (found === undefined) return undefined;
      const inner = text.slice(found.innerStart, found.end);
      const notes = [];
      let current;
      let quoteLines;
      let mode;
      for (const raw of inner.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (line.trim() === '') {
          mode = undefined;
          continue;
        }
        if (line.startsWith('>')) {
          if (mode !== 'quote') {
            quoteLines = [];
            current = { quote: '', comment: '' };
            notes.push(current);
            mode = 'quote';
          }
          quoteLines.push(line.replace(/^>\s?/, ''));
          current.quote = quoteLines.join('\n');
          continue;
        }
        if (line.startsWith('注释：')) {
          if (current === undefined) {
            current = { quote: '', comment: '' };
            notes.push(current);
          }
          current.comment = line.slice(3).trim();
          mode = 'comment';
          continue;
        }
        if (current !== undefined) {
          if (mode === 'comment') current.comment += `\n${line.trim()}`;
          else current.quote += `\n${line}`;
        }
      }
      if (notes.length === 0) return undefined;
      return { clean: text.slice(0, found.start).trim(), notes, marker: found.marker };
    }

    /**
     * Collapse the annotation block of already-sent user messages into a
     * `N 条注释` pill, like Codex. The block stays in the stored message (the
     * model still sees it); only the rendering is replaced.
     * @param t - translate function bound to this plugin's namespace.
     * @returns disposer removing the observer, listeners, popover and pills.
     */
    function installSentAnnotationRenderer(t) {
      if (typeof document === 'undefined') return () => {};

      let popover;
      let raf = 0;

      const closePopover = () => {
        if (popover !== undefined) {
          popover.remove();
          popover = undefined;
        }
      };

      const openPopover = (anchor, notes) => {
        closePopover();
        const el = document.createElement('div');
        el.className = 'dsh-cl-sent-pop';
        notes.forEach((note, index) => {
          const row = document.createElement('div');
          row.className = 'dsh-cl-anno-row';
          const number = document.createElement('span');
          number.className = 'dsh-cl-anno-index';
          number.textContent = `${index + 1}.`;
          const body = document.createElement('div');
          body.className = 'dsh-cl-anno-body';
          const quoteLabel = document.createElement('div');
          quoteLabel.className = 'dsh-cl-anno-label';
          quoteLabel.textContent = t('anno.quoteLabel');
          const quote = document.createElement('div');
          quote.className = 'dsh-cl-anno-rowquote';
          quote.textContent = note.quote;
          const commentLabel = document.createElement('div');
          commentLabel.className = 'dsh-cl-anno-label';
          commentLabel.textContent = t('anno.commentLabel');
          const comment = document.createElement('div');
          comment.className = 'dsh-cl-anno-comment';
          comment.textContent = note.comment === '' ? '—' : note.comment;
          body.append(quoteLabel, quote, commentLabel, comment);
          row.append(number, body);
          el.appendChild(row);
        });
        document.body.appendChild(el);
        const rect = anchor.getBoundingClientRect();
        el.style.left = `${Math.max(8, Math.min(window.innerWidth - 456, rect.left))}px`;
        el.style.top = `${Math.max(8, Math.min(window.innerHeight - 220, rect.bottom + 6))}px`;
        popover = el;
      };

      /** Hide the block's rendered nodes; returns the element the pill joins. */
      const hideBlock = (root, marker) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let startNode;
        let endNode;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const value = node.nodeValue || '';
          if (startNode === undefined) {
            if (value.includes(marker.start)) startNode = node;
          } else if (value.includes(marker.end)) {
            endNode = node;
            break;
          }
        }
        if (startNode === undefined) return undefined;
        const startEl = startNode.parentElement;
        if (startEl === null) return undefined;
        const endEl = endNode !== undefined ? endNode.parentElement : null;

        if (endEl !== null && endEl !== startEl) {
          const ancestors = new Set();
          for (let el = endEl; el !== null; el = el.parentElement) ancestors.add(el);
          let common = startEl;
          while (common !== null && !ancestors.has(common)) common = common.parentElement;
          if (common !== null) {
            let hiding = false;
            for (const child of Array.from(common.children)) {
              if (!hiding && child.contains(startEl)) hiding = true;
              if (!hiding) continue;
              child.style.display = 'none';
              if (child.contains(endEl)) break;
            }
            return common;
          }
        }

        // Same block (or a missing end marker): keep the text before the block.
        const text = startEl.textContent || '';
        const cut = text.indexOf(marker.start);
        startEl.textContent = cut >= 0 ? text.slice(0, cut) : '';
        startEl.style.display = '';
        return startEl.parentElement ?? startEl;
      };

      const scan = () => {
        raf = 0;
        const wrappers = new Set();
        for (const selector of [
          '[data-chat-flow-kind="user"]',
          '[data-chat-flow-kind="steering"]',
          '[data-slot="conversation.chat.node"]',
        ]) {
          for (const element of document.querySelectorAll(selector)) {
            const text = element.textContent || '';
            if (text.includes(ANNO_START) || text.includes(ANNO_END)) wrappers.add(element);
          }
        }
        for (const node of wrappers) {
          if (node.querySelector('.dsh-cl-sent-anno') !== null) continue;
          const text = node.textContent || '';
          const parsed = parseSentAnnotations(text);
          if (parsed === undefined) continue;
          const host = hideBlock(node, parsed.marker);
          if (host === undefined) continue;
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'dsh-cl-sent-anno';
          pill.textContent = `${parsed.notes.length} ${t('anno.count')}`;
          pill.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openPopover(pill, parsed.notes);
          });
          host.appendChild(pill);
        }
      };

      const schedule = () => {
        if (raf !== 0) return;
        raf = window.requestAnimationFrame(scan);
      };

      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      const onDocumentClick = (event) => {
        if (popover === undefined) return;
        if (popover.contains(event.target)) return;
        if (event.target instanceof Element && event.target.closest('.dsh-cl-sent-anno') !== null) return;
        closePopover();
      };
      const onScroll = () => closePopover();
      document.addEventListener('click', onDocumentClick);
      window.addEventListener('scroll', onScroll, true);
      schedule();

      return () => {
        observer.disconnect();
        if (raf !== 0) window.cancelAnimationFrame(raf);
        document.removeEventListener('click', onDocumentClick);
        window.removeEventListener('scroll', onScroll, true);
        closePopover();
        for (const pill of document.querySelectorAll('.dsh-cl-sent-anno')) pill.remove();
      };
    }

    /** Chat glyph shared by the pending pill and the selection menu. */
    function annotationIcon(size) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M13 9.5A1.5 1.5 0 0 1 11.5 11H5l-2.5 2.5v-8A1.5 1.5 0 0 1 4 4h7.5A1.5 1.5 0 0 1 13 5.5z' }),
      );
    }

    /**
     * Mount the select-text toolbar and its annotation editor.
     * @param t - translate function bound to this plugin's namespace.
     * @returns disposer removing every DOM node and listener.
     */
    function installSelectionToolbar(t) {
      if (typeof document === 'undefined') return () => {};

      const menu = document.createElement('div');
      menu.className = 'dsh-cl-anno-menu';
      menu.hidden = true;
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.textContent = t('anno.add');
      menu.appendChild(addButton);
      document.body.appendChild(menu);

      const editor = document.createElement('div');
      editor.className = 'dsh-cl-anno-editor';
      editor.hidden = true;
      editor.innerHTML =
        '<input type="text" class="dsh-cl-anno-input" /><button type="button" class="dsh-cl-anno-check">✓</button>';
      document.body.appendChild(editor);
      const inputEl = editor.querySelector('.dsh-cl-anno-input');
      const checkEl = editor.querySelector('.dsh-cl-anno-check');
      inputEl.placeholder = t('anno.placeholder');
      checkEl.setAttribute('aria-label', t('anno.save'));
      checkEl.title = t('anno.save');

      let pending = undefined;
      let editingId = undefined;
      let editorOpen = false;

      const hideMenu = () => {
        menu.hidden = true;
        pending = undefined;
      };

      const closeEditor = () => {
        editorOpen = false;
        editingId = undefined;
        editor.hidden = true;
        inputEl.value = '';
      };

      const placeEditor = (rect) => {
        const width = 360;
        editor.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
        const above = rect.top - 56;
        editor.style.top = `${above > 8 ? above : rect.bottom + 8}px`;
      };

      const openEditor = () => {
        if (pending === undefined) return;
        editorOpen = true;
        menu.hidden = true;
        placeEditor(pending.rect);
        editor.hidden = false;
        inputEl.value = '';
        inputEl.focus();
      };

      const openEditEditor = (detail) => {
        if (detail === null || typeof detail !== 'object' || typeof detail.id !== 'number') return;
        editingId = detail.id;
        editorOpen = true;
        menu.hidden = true;
        const rect =
          detail.rect !== null && typeof detail.rect === 'object'
            ? detail.rect
            : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0, bottom: window.innerHeight / 2 };
        placeEditor(rect);
        editor.hidden = false;
        inputEl.value = typeof detail.comment === 'string' ? detail.comment : '';
        inputEl.focus();
        inputEl.select();
      };

      const commit = () => {
        if (editingId !== undefined) {
          updateAnnotation(editingId, inputEl.value.trim());
          closeEditor();
          return;
        }
        if (pending === undefined) return;
        addAnnotation(pending.text, inputEl.value.trim(), pending.range);
        closeEditor();
        pending = undefined;
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      };

      const inspectSelection = () => {
        if (editorOpen) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          hideMenu();
          return;
        }
        const range = selection.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) {
          hideMenu();
          return;
        }
        if (
          element.closest(
            '[data-composer-card], textarea, input, [contenteditable="true"], .dsh-cl-anno-menu, .dsh-cl-anno-editor, .dsh-cl-anno-pop',
          )
        ) {
          hideMenu();
          return;
        }
        if (!element.closest('[data-conversation-region="chat"]')) {
          hideMenu();
          return;
        }
        const text = selection.toString().trim();
        if (text === '') {
          hideMenu();
          return;
        }
        pending = { text: text.slice(0, 6000), rect: range.getBoundingClientRect(), range: range.cloneRange() };
        const rect = pending.rect;
        menu.hidden = false;
        const width = menu.offsetWidth || 120;
        menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
        menu.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, rect.top - 44))}px`;
      };

      const onMouseUp = (event) => {
        if (menu.contains(event.target) || editor.contains(event.target)) return;
        window.setTimeout(inspectSelection, 0);
      };
      const onMouseDown = (event) => {
        if (menu.contains(event.target) || editor.contains(event.target)) return;
        if (editorOpen && !editor.hidden) {
          // A click outside the editor cancels it (and keeps the selection free).
          if (!editor.contains(event.target)) closeEditor();
        }
      };
      const onScroll = () => {
        if (!menu.hidden) hideMenu();
      };
      const onKeyDown = (event) => {
        if (!editorOpen) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closeEditor();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          commit();
        }
      };

      addButton.addEventListener('click', openEditor);
      checkEl.addEventListener('click', commit);
      const onEditRequest = (event) => openEditEditor(event.detail);
      window.addEventListener('dsh-interaction-optimize:annotation-edit', onEditRequest);
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('scroll', onScroll, true);
      document.addEventListener('keydown', onKeyDown, true);

      return () => {
        window.removeEventListener('dsh-interaction-optimize:annotation-edit', onEditRequest);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('scroll', onScroll, true);
        document.removeEventListener('keydown', onKeyDown, true);
        menu.remove();
        editor.remove();
      };
    }

    // ------------------------------------------------------------------
    // Turn signals and presentation helpers.
    // ------------------------------------------------------------------

    /**
     * Read the plain-text part of one durable `assistant/message` event.
     * @param event - the session event.
     * @returns collapsed text, or undefined when the message carries none.
     */
    function assistantTextOf(event) {
      const content = event && event.data && event.data.message ? event.data.message.content : undefined;
      if (!Array.isArray(content)) return undefined;
      let text = '';
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += ` ${block.text}`;
      }
      const collapsed = text.replace(/\s+/g, ' ').trim();
      return collapsed === '' ? undefined : collapsed;
    }

    /** Read one `turn/end` reason kind as a display tone, or null when nothing should be shown. */
    function toneOf(kind) {
      return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(TONE_BY_KIND, kind)
        ? TONE_BY_KIND[kind]
        : null;
    }

    function titleKeyOf(tone) {
      if (tone === 'error') return 'toast.error';
      if (tone === 'warning') return 'toast.maxTokens';
      return 'toast.completed';
    }

    function truncate(text) {
      if (typeof text !== 'string') return undefined;
      const trimmed = text.trim();
      if (trimmed === '') return undefined;
      return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…` : trimmed;
    }

    /** Select the session the main view currently retains, without allocating per snapshot. */
    function selectMainSessionId(state) {
      if (!state || !Array.isArray(state.ids) || !state.byId) return undefined;
      for (const id of state.ids) {
        const row = state.byId[id];
        if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return id;
      }
      return undefined;
    }

    function selectRunning(snapshot, sessionId) {
      if (typeof sessionId !== 'string' || !snapshot || typeof snapshot.get !== 'function') return false;
      const status = snapshot.get(sessionId);
      return status !== undefined && status.running === true;
    }

    function selectSessionTitle(state, sessionId) {
      if (typeof sessionId !== 'string' || !state || !state.byId) return undefined;
      const row = state.byId[sessionId];
      return row && typeof row.displayTitle === 'string' ? row.displayTitle : undefined;
    }

    // ------------------------------------------------------------------
    // In-app toast (shell.overlay).
    // ------------------------------------------------------------------

    function TurnCompleteToast(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined;
      const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : () => false;
      const getSessionEventSource = props.getSessionEventSource;
      const settings = React.useSyncExternalStore(subscribeSettings, getSettings);

      const sessionId = useSessions(selectMainSessionId);
      const running = useSessionStatus((snapshot) => selectRunning(snapshot, sessionId));
      const sessionTitle = useSessions((state) => selectSessionTitle(state, sessionId));

      const [toast, setToast] = React.useState(null);
      const [hovered, setHovered] = React.useState(false);
      const [pageVisible, setPageVisible] = React.useState(() => (typeof document === 'undefined' ? true : !document.hidden));
      const seqRef = React.useRef(0);
      const preciseAtRef = React.useRef(0);
      const previousRunningRef = React.useRef({ sessionId: undefined, running: false });
      // Read through refs so a title/settings refresh never re-subscribes the
      // event source (a resubscription re-baselines the revision and could skip
      // a turn boundary).
      const sessionTitleRef = React.useRef(sessionTitle);
      sessionTitleRef.current = sessionTitle;
      const settingsRef = React.useRef(settings);
      settingsRef.current = settings;
      const translateRef = React.useRef(t);
      translateRef.current = t;
      const sessionIdRef = React.useRef(sessionId);
      sessionIdRef.current = sessionId;
      // The last reply text seen in the current turn, shown as the excerpt.
      const lastReplyRef = React.useRef(undefined);

      const showToast = React.useCallback((tone, detail, options) => {
        const opts = options !== null && typeof options === 'object' ? options : {};
        const hold =
          typeof opts.holdSeconds === 'number' && Number.isFinite(opts.holdSeconds)
            ? opts.holdSeconds
            : getSettings().holdSeconds;
        seqRef.current += 1;
        setToast({
          seq: seqRef.current,
          tone,
          detail: truncate(detail),
          holdSeconds: hold,
          preview: opts.preview === true,
        });
      }, []);

      const dismiss = React.useCallback(() => {
        setHovered(false);
        setToast(null);
      }, []);

      /** Fan one finished turn out to every enabled channel. */
      const deliver = React.useCallback(
        (tone, detail) => {
          const current = settingsRef.current;
          const shown = truncate(detail);
          if (current.inAppToast) showToast(tone, shown);
          if (current.sound) playSelectedSound();
          if (shouldNotifySystem(current)) {
            const currentSession = sessionIdRef.current;
            showSystemNotification(
              translateRef.current(titleKeyOf(tone)),
              shown,
              typeof currentSession === 'string' ? currentSession : 'dsh-interaction-optimize',
            );
          }
        },
        [showToast],
      );
      const deliverRef = React.useRef(deliver);
      deliverRef.current = deliver;

      // Let the configuration page render a sample notice on demand, using the
      // display duration that page currently shows.
      React.useEffect(
        () =>
          subscribeToastPreview((holdSeconds) =>
            showToast('success', translateRef.current('settings.previewSample'), {
              preview: true,
              holdSeconds,
            }),
          ),
        [showToast],
      );

      // Precise signal: the session's own durable turn boundary.
      const eventSource =
        typeof sessionId === 'string' && typeof getSessionEventSource === 'function'
          ? getSessionEventSource(sessionId)
          : undefined;

      React.useEffect(() => {
        if (!eventSource || typeof eventSource.subscribe !== 'function' || typeof eventSource.getSnapshot !== 'function') {
          return undefined;
        }
        lastReplyRef.current = undefined;
        let revision = eventSource.getSnapshot().revision;
        const unsubscribe = eventSource.subscribe(() => {
          const snapshot = eventSource.getSnapshot();
          if (!snapshot || snapshot.revision === revision) return;
          revision = snapshot.revision;
          const change = snapshot.change;
          if (!change || change.kind !== 'append' || !Array.isArray(change.entries)) return;
          for (const entry of change.entries) {
            if (!entry || entry.type !== 'event' || !entry.event) continue;
            const event = entry.event;
            // Keep the newest reply text so the notice can excerpt the answer.
            if (event.type === 'turn/start') {
              lastReplyRef.current = undefined;
              continue;
            }
            if (event.type === 'assistant/message') {
              const text = assistantTextOf(event);
              if (text !== undefined) lastReplyRef.current = text;
              continue;
            }
            if (event.type !== 'turn/end') continue;
            const reason = event.data ? event.data.reason : undefined;
            const tone = toneOf(reason ? reason.kind : undefined);
            // Record every observed boundary, including aborts, so the running-flag
            // fallback stays quiet for a turn the precise signal already judged.
            preciseAtRef.current = Date.now();
            if (tone === null) continue;
            const errorMessage = reason && reason.error ? reason.error.message : undefined;
            deliverRef.current(
              tone,
              tone === 'error' ? errorMessage : (lastReplyRef.current ?? sessionTitleRef.current),
            );
          }
        });
        return unsubscribe;
      }, [sessionId, eventSource]);

      // Fallback signal: the status flag only ever flips off when the running
      // interval ends, so a build without an event source still reports completion.
      React.useEffect(() => {
        const previous = previousRunningRef.current;
        previousRunningRef.current = { sessionId, running };
        if (previous.sessionId !== sessionId) return;
        if (!previous.running || running) return;
        if (Date.now() - preciseAtRef.current < PRECISE_DEDUPE_MS) return;
        deliverRef.current('success', lastReplyRef.current ?? sessionTitleRef.current);
      }, [sessionId, running]);

      // A new turn replaces the finished one's notice, but never a manual preview.
      React.useEffect(() => {
        if (!running) return;
        setToast((current) => (current !== null && current.preview === true ? current : null));
      }, [running]);

      // Unlock audio on the first user gesture so the first chime is audible
      // under the browser autoplay policy.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const unlock = () => {
          try {
            ensureAudioContext();
          } catch {
            /* audio unavailable */
          }
        };
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('keydown', unlock, true);
        return () => {
          document.removeEventListener('pointerdown', unlock, true);
          document.removeEventListener('keydown', unlock, true);
        };
      }, []);

      // A turn that finishes in a hidden tab must still be readable on return:
      // hold the toast while the page is hidden and start the countdown after.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onVisibilityChange = () => setPageVisible(!document.hidden);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
      }, []);

      React.useEffect(() => {
        if (toast === null || hovered || !pageVisible) return undefined;
        // The duration is fixed when the toast appears, so changing the setting
        // afterwards affects the next notice rather than restarting this one.
        const holdMs = toast.holdSeconds * 1000;
        if (!(holdMs > 0)) return undefined;
        const seq = toast.seq;
        const timer = window.setTimeout(() => {
          setToast((current) => (current !== null && current.seq === seq ? null : current));
        }, holdMs);
        return () => window.clearTimeout(timer);
      }, [toast, hovered, pageVisible]);

      return h('div', { className: 'dsh-tct-layer' }, [
        h('style', { key: 'style' }, CSS),
        toast === null
          ? null
          : h(
              'div',
              {
                key: toast.seq,
                className: 'dsh-tct-card',
                role: 'status',
                'aria-live': 'polite',
                'aria-atomic': 'true',
                'data-tone': toast.tone,
                translate: 'no',
                onMouseEnter: () => setHovered(true),
                onMouseLeave: () => setHovered(false),
              },
              [
                h('span', { key: 'icon', className: 'dsh-tct-icon', 'aria-hidden': 'true' }, iconOf(toast.tone)),
                h('span', { key: 'body', className: 'dsh-tct-body' }, [
                  h('span', { key: 'title', className: 'dsh-tct-title' }, t(titleKeyOf(toast.tone))),
                  toast.detail === undefined
                    ? null
                    : h('span', { key: 'detail', className: 'dsh-tct-detail', title: toast.detail }, toast.detail),
                ]),
                h(
                  'button',
                  {
                    key: 'close',
                    type: 'button',
                    className: 'dsh-tct-close',
                    'aria-label': t('toast.close'),
                    title: t('toast.close'),
                    onClick: dismiss,
                  },
                  closeIcon(),
                ),
              ],
            ),
      ]);
    }

    // ------------------------------------------------------------------
    // Diff badge above the composer (conversation.input.dock).
    // ------------------------------------------------------------------

    /**
     * Show the latest `workspace/changes` summary of this Session: added and
     * deleted line counts plus the number of changed files. The Host records
     * each summary; this component polls it while a turn runs and once more
     * when the turn settles.
     */
    function DiffDock(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const sessionId = props.sessionId;
      const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : () => false;
      const settings = React.useSyncExternalStore(subscribeSettings, getSettings);
      const enabled = settings.diffBadge;
      const running = useSessionStatus((snapshot) =>
        snapshot && typeof snapshot.get === 'function' && typeof sessionId === 'string'
          ? snapshot.get(sessionId)?.running === true
          : false,
      );
      const [changes, setChanges] = React.useState(null);
      const [filesOpen, setFilesOpen] = React.useState(false);

      React.useEffect(() => {
        if (!enabled) return undefined;
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let cancelled = false;
        setChanges(null);
        const load = async () => {
          try {
            const response = await fetch(`${CHANGES_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
            });
            if (!response.ok) return;
            const data = await response.json();
            if (!cancelled) setChanges(data && data.changes ? data.changes : null);
          } catch {
            /* the Host route is unavailable (older Host half) */
          }
        };
        void load();
        const period = running ? CHANGES_POLL_MS : CHANGES_IDLE_POLL_MS;
        const timer = window.setInterval(() => {
          void load();
        }, period);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [enabled, sessionId, running]);

      if (!enabled || changes === null) return null;
      const added = Number.isFinite(changes.added) ? changes.added : 0;
      const deleted = Number.isFinite(changes.deleted) ? changes.deleted : 0;
      const total = Number.isFinite(changes.total) ? changes.total : 0;
      if (added === 0 && deleted === 0 && total === 0) return null;

      const formatCount = (value) => Number(value).toLocaleString('en-US');
      const fileLabel = total === 1 ? t('diff.filesChangedOne') : t('diff.filesChangedMany');
      const openChangesReview = props.openChangesReview;
      const canOpen = typeof openChangesReview === 'function' && Number.isFinite(changes.seq);
      const files = Array.isArray(changes.files) ? changes.files : [];

      const openReview = (index) => {
        try {
          openChangesReview(sessionId, changes.seq, changes.turn, index);
        } catch {
          /* no right Sidebar in this composition, or no on-screen session */
        }
      };

      const pillProps = { className: 'dsh-cl-pill' };
      if (canOpen) {
        pillProps.type = 'button';
        pillProps['aria-label'] = t('diff.openReview');
        pillProps.onClick = () => openReview(0);
      } else {
        pillProps.role = 'status';
      }

      const fileRows = files.map((file, index) => {
        const name = (typeof file.display === 'string' ? file.display : file.path) || '';
        const counts =
          file.binary === true
            ? h('span', { key: 'counts', className: 'dsh-cl-file-note' }, t('diff.binary'))
            : file.oversized === true
              ? h('span', { key: 'counts', className: 'dsh-cl-file-note' }, t('diff.oversized'))
              : [
                  h(
                    'span',
                    { key: 'added', className: 'dsh-cl-file-add' },
                    `+${formatCount(Number.isFinite(file.added) ? file.added : 0)}`,
                  ),
                  h(
                    'span',
                    { key: 'deleted', className: 'dsh-cl-file-del' },
                    `-${formatCount(Number.isFinite(file.deleted) ? file.deleted : 0)}`,
                  ),
                ];
        const rowProps = { key: `${index}:${name}`, className: 'dsh-cl-file', title: name };
        const children = [
          h('span', { key: 'name', className: 'dsh-cl-file-name' }, name),
          h('span', { key: 'counts', className: 'dsh-cl-file-counts' }, counts),
        ];
        if (!canOpen) return h('div', rowProps, children);
        rowProps.type = 'button';
        rowProps.onClick = () => openReview(index);
        return h('button', rowProps, children);
      });

      return h(
        'div',
        { className: 'dsh-cl-diff' },
        h(
          'div',
          {
            className: 'dsh-cl-anchor',
            onMouseEnter: () => setFilesOpen(true),
            onMouseLeave: () => setFilesOpen(false),
          },
          [
            filesOpen && fileRows.length > 0
              ? h(
                  'div',
                  { key: 'pop-wrap', className: 'dsh-cl-pop-wrap' },
                  h(
                    'div',
                    { className: 'dsh-cl-pop', role: 'group', 'aria-label': t('diff.openReview') },
                    fileRows,
                  ),
                )
              : null,
            h(
              canOpen ? 'button' : 'span',
              pillProps,
              [
                h('span', { key: 'files' }, `${total} ${fileLabel}`),
                h('span', { key: 'added', className: 'dsh-cl-add' }, `+${formatCount(added)}`),
                h('span', { key: 'deleted', className: 'dsh-cl-del' }, `-${formatCount(deleted)}`),
              ],
            ),
          ],
        ),
      );
    }

    // ------------------------------------------------------------------
    // File context menu (right-click a file link in the conversation).
    // ------------------------------------------------------------------

    /**
     * Show the file context menu for links: open with the default
     * application, reveal in the file manager, or pick another registered
     * application. Actions go through the plugin's Host route, which performs
     * the native open in-process (the same opener the built-in open-in-app uses).
     * @param getEnabled - whether the menu is enabled in settings.
     * @param getScope - the retained session's id and working directory.
     * @param t - translate function bound to this plugin's namespace.
     * @returns disposer removing listeners and the menu.
     */
    function installFileContextMenu(getEnabled, getScope, t) {
      if (typeof document === 'undefined') return () => {};

      let menu;

      const close = () => {
        if (menu !== undefined) {
          menu.remove();
          menu = undefined;
        }
      };

      const scopeOf = () => (typeof getScope === 'function' ? getScope() : undefined);

      const toAbsolute = (path, cwd) => {
        if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) return path;
        if (typeof cwd === 'string' && cwd.trim() !== '') {
          const separator = cwd.endsWith('\\') || cwd.endsWith('/') ? '' : '\\';
          return `${cwd}${separator}${path}`;
        }
        return path;
      };

      const hostOpen = async (path, action, application) => {
        const scope = scopeOf();
        try {
          const response = await fetch('/dsh-interaction-optimize/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path,
              action,
              application,
              session: scope && typeof scope.id === 'string' ? scope.id : undefined,
              cwd: scope && typeof scope.cwd === 'string' ? scope.cwd : undefined,
            }),
          });
          const payload = await response.json().catch(() => undefined);
          if (response.ok && payload !== undefined && payload.ok === true) return { ok: true };
          const detail =
            payload !== undefined && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
          return { ok: false, detail };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      };

      const hostApps = async (path) => {
        const scope = scopeOf();
        try {
          const query = new URLSearchParams({ path });
          if (scope && typeof scope.cwd === 'string') query.set('cwd', scope.cwd);
          if (scope && typeof scope.id === 'string') query.set('session', scope.id);
          const response = await fetch(`/dsh-interaction-optimize/apps?${query.toString()}`);
          const payload = await response.json().catch(() => undefined);
          if (!response.ok || payload === undefined || payload.ok !== true || !Array.isArray(payload.apps)) {
            return undefined;
          }
          return payload.apps;
        } catch {
          return undefined;
        }
      };

      const basename = (path) => {
        const parts = String(path).split(/[\\/]/).filter((part) => part !== '');
        return parts.length > 0 ? parts[parts.length - 1] : path;
      };

      const place = (element, x, y) => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x));
        const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, y));
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
      };

      const menuItem = (label, onClick, options) => {
        const settings = options ?? {};
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dsh-cl-file-menu-item';
        if (settings.disabled === true) button.disabled = true;
        const icon = document.createElement('span');
        icon.className = 'dsh-cl-file-menu-icon';
        if (typeof settings.icon === 'string' && settings.icon !== '') {
          const image = document.createElement('img');
          image.src = settings.icon;
          image.alt = '';
          icon.appendChild(image);
        } else {
          icon.textContent = settings.glyph ?? '•';
        }
        const text = document.createElement('span');
        text.className = 'dsh-cl-file-menu-label';
        text.textContent = label;
        button.append(icon, text);
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (settings.disabled === true) return;
          onClick();
        });
        return button;
      };

      const buildShell = (path) => {
        const element = document.createElement('div');
        element.className = 'dsh-cl-file-menu';
        element.setAttribute('role', 'menu');
        const title = document.createElement('div');
        title.className = 'dsh-cl-file-menu-title';
        title.textContent = basename(path);
        title.title = path;
        element.appendChild(title);
        return { element, title };
      };

      const showApplications = async (x, y, path) => {
        close();
        const { element, title } = buildShell(path);
        const scope = scopeOf();
        const absolutePath = toAbsolute(path, scope && scope.cwd);
        const loading = menuItem(t('fileMenu.loading'), () => {}, { disabled: true });
        element.appendChild(loading);
        document.body.appendChild(element);
        place(element, x, y);
        menu = element;

        const apps = await hostApps(absolutePath);
        if (menu !== element) return; // superseded while loading
        element.removeChild(loading);
        if (apps === undefined) {
          // The native handler list is unavailable in this deployment: fall
          // back to the shell's own "Open with" dialog.
          const result = await hostOpen(absolutePath, 'pick');
          if (result.ok) {
            close();
            return;
          }
          element.appendChild(
            menuItem(`${t('fileMenu.failed')}：${result.detail}`, () => {}, { disabled: true }),
          );
        } else if (apps.length === 0) {
          element.appendChild(menuItem(t('fileMenu.noApps'), () => {}, { disabled: true }));
        } else {
          for (const app of apps) {
            if (app === null || typeof app !== 'object' || typeof app.name !== 'string') continue;
            const label = app.default === true ? `${app.name} · ${t('fileMenu.default')}` : app.name;
            element.appendChild(
              menuItem(
                label,
                () => {
                  void (async () => {
                    const result = await hostOpen(absolutePath, 'open', app.id);
                    if (result.ok) {
                      close();
                      return;
                    }
                    title.textContent = `${basename(path)} · ${t('fileMenu.failed')}：${result.detail}`;
                  })();
                },
                { icon: typeof app.icon === 'string' ? app.icon : undefined, glyph: '▸' },
              ),
            );
          }
        }
        element.appendChild(menuItem(t('fileMenu.back'), () => showMenu(x, y, path), { glyph: '←' }));
        place(element, x, y);
      };

      const showMenu = (x, y, path) => {
        close();
        const { element, title } = buildShell(path);
        const run = async (action) => {
          const scope = scopeOf();
          const absolutePath = toAbsolute(path, scope && scope.cwd);
          const viaHost = await hostOpen(absolutePath, action);
          if (viaHost.ok) {
            close();
            return;
          }
          title.textContent = `${basename(path)} · ${t('fileMenu.failed')}：${viaHost.detail}`;
          title.title = path;
        };
        element.appendChild(menuItem(t('fileMenu.open'), () => void run('open'), { glyph: '↗' }));
        element.appendChild(menuItem(t('fileMenu.reveal'), () => void run('reveal'), { glyph: '▤' }));
        element.appendChild(
          menuItem(t('fileMenu.other'), () => void showApplications(x, y, path), { glyph: '…' }),
        );
        document.body.appendChild(element);
        place(element, x, y);
        menu = element;
      };

      const pathFromElement = (element) => {
        const title = (element.getAttribute('title') || '').trim();
        let candidate = title;
        if (candidate === '' && element instanceof HTMLAnchorElement) {
          candidate = (element.getAttribute('href') || '').trim();
        }
        if (candidate === '') return undefined;
        let path = candidate.replace(/^@/, '').replace(/^["'`]|["'`]$/g, '').trim();
        if (/^(https?:|mailto:|data:)/i.test(path)) return undefined;
        if (path.startsWith('file://')) {
          try {
            path = decodeURIComponent(new URL(path).pathname);
          } catch {
            return undefined;
          }
        }
        if (path === '' || /^#/.test(path)) return undefined;
        // Require a path separator or a file extension: plain link labels and
        // tooltips must not turn into file menus.
        if (!/[\\/]/.test(path) && !/\.[A-Za-z0-9]{1,10}$/.test(path)) return undefined;
        return path;
      };

      const onContextMenu = (event) => {
        if (!(event.target instanceof Element)) return;
        if (typeof getEnabled === 'function' && getEnabled() !== true) return;
        if (event.target.closest('[data-conversation-scroll], [data-chat-flow-kind], [data-slot="conversation.chat.node"]') === null) {
          return;
        }
        const element = event.target.closest('a[href], [title]');
        if (element === null) return;
        const path = pathFromElement(element);
        if (path === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu(event.clientX, event.clientY, path);
      };

      const onPointerDown = (event) => {
        if (menu !== undefined && !menu.contains(event.target)) close();
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') close();
      };
      const onScroll = () => close();

      document.addEventListener('contextmenu', onContextMenu);
      document.addEventListener('mousedown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);

      return () => {
        document.removeEventListener('contextmenu', onContextMenu);
        document.removeEventListener('mousedown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
        close();
      };
    }

    // ------------------------------------------------------------------
    // Pending annotation pill (conversation.input.dock).
    // ------------------------------------------------------------------

    /**
     * Show the pending annotations and inject them right before the composer
     * sends. The interception mirrors the composer's own submit surfaces: the
     * card's last button and Enter inside the card.
     */
    function AnnotationDock(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const sessionId = props.sessionId;
      const useInput = typeof props.useInput === 'function' ? props.useInput : () => '';
      const inputActions = props.inputActions;
      const list = React.useSyncExternalStore(subscribeAnnotations, annotationSnapshot);
      const [open, setOpen] = React.useState(false);
      const draft = useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''));
      const draftRef = React.useRef(draft);
      draftRef.current = draft;
      const listRef = React.useRef(list);
      listRef.current = list;
      const injectingRef = React.useRef(false);

      // Pending comments belong to the conversation they were written in; a
      // remount of the same conversation (panel switch) keeps them.
      React.useEffect(() => {
        if (annotationsSessionId !== sessionId) {
          annotationsSessionId = sessionId;
          clearAnnotations();
        }
        setOpen(false);
      }, [sessionId]);

      React.useEffect(() => {
        const openList = () => setOpen(true);
        window.addEventListener('dsh-interaction-optimize:annotations-open', openList);
        return () => window.removeEventListener('dsh-interaction-optimize:annotations-open', openList);
      }, []);

      // Pending comments must be sendable on their own: keep one invisible
      // separator in the draft so the composer's send control stays enabled,
      // and remove it again once the list empties.
      React.useEffect(() => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') return;
        const draftText = draftRef.current || '';
        const hasToken = draftText.includes(ANNOTATION_TOKEN);
        if (list.length > 0 && !hasToken) {
          try {
            inputActions.setDraft(`${draftText}${ANNOTATION_TOKEN}`);
          } catch {
            /* composer not ready */
          }
        } else if (list.length === 0 && hasToken) {
          try {
            inputActions.setDraft(draftText.split(ANNOTATION_TOKEN).join(''));
          } catch {
            /* composer not ready */
          }
        }
      }, [list.length, inputActions]);

      React.useEffect(() => {
        // Two send paths:
        //  - draft has text: append the block to the draft and let the native
        //    send continue;
        //  - draft is empty (annotations only): the composer's own submit is
        //    unreliable here, so send the block straight through the session
        //    prompt API.
        const submitAnnotations = props.submitAnnotations;

        const promptOnly = (block) => {
          if (typeof submitAnnotations !== 'function') {
            try {
              inputActions.setDraft(block);
            } catch {
              /* composer not ready */
            }
            return;
          }
          Promise.resolve(submitAnnotations(sessionId, block)).then(
            (ok) => {
              if (ok === true) {
                clearAnnotations();
                try {
                  inputActions.setDraft('');
                } catch {
                  /* composer not ready */
                }
                return;
              }
              try {
                inputActions.setDraft(block);
              } catch {
                /* composer not ready */
              }
            },
            () => {
              try {
                inputActions.setDraft(block);
              } catch {
                /* composer not ready */
              }
            },
          );
        };

        const inject = (event) => {
          const notes = listRef.current;
          if (notes.length === 0 || injectingRef.current) return false;
          if (!inputActions || typeof inputActions.setDraft !== 'function') return false;
          const draftText = (draftRef.current || '').split(ANNOTATION_TOKEN).join('');
          // Already carrying the block (a previous attempt): let the native send
          // proceed and retire the pending list with it.
          if (draftText.includes(ANNO_START)) {
            clearAnnotations();
            return false;
          }
          // The input projection is the only trustworthy draft source. If it is
          // empty while the editor visibly holds text, leave the send untouched.
          if (draftText.trim() === '') {
            const editorEl = document.querySelector('[data-composer-card] [data-lexical-editor]');
            const domText =
              editorEl !== null ? (editorEl.textContent || '').split(ANNOTATION_TOKEN).join('').trim() : '';
            if (domText !== '') return false;
            // Empty composer: annotations only, take over the send.
            const block = buildAnnotationBlock(notes);
            if (event !== undefined) {
              event.preventDefault();
              event.stopPropagation();
            }
            injectingRef.current = true;
            promptOnly(block);
            window.setTimeout(() => {
              injectingRef.current = false;
            }, 500);
            return true;
          }
          const block = buildAnnotationBlock(notes);
          injectingRef.current = true;
          try {
            inputActions.setDraft(`${draftText.trim()}\n\n${block}`);
          } catch {
            injectingRef.current = false;
            return false;
          }
          // The block now lives in the draft; the pending list has served its purpose.
          clearAnnotations();
          window.setTimeout(() => {
            injectingRef.current = false;
          }, 0);
          return true;
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
          const target = event.target;
          if (!target || typeof target.closest !== 'function' || target.closest('[data-composer-card]') === null) return;
          inject(event);
        };
        const onClick = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return;
          const card = target.closest('[data-composer-card]');
          if (card === null) return;
          const button = target.closest('button');
          if (button === null || button.getAttribute('aria-haspopup') !== null) return;
          // The composer's submit control is its primary button; keep the
          // last-button heuristic as a fallback for other compositions.
          const className = typeof button.className === 'string' ? button.className : '';
          const isPrimary = /(^|[\s-])[A-Za-z0-9]+_primary(\s|$)/.test(className);
          const buttons = Array.from(card.querySelectorAll('button'));
          const isLast = buttons[buttons.length - 1] === button;
          if (!isPrimary && !isLast) return;
          inject(event);
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('click', onClick, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('click', onClick, true);
        };
      }, [inputActions, props.submitAnnotations]);

      if (list.length === 0) return null;

      const editAnnotation = (note, event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        window.dispatchEvent(
          new CustomEvent('dsh-interaction-optimize:annotation-edit', {
            detail: { id: note.id, comment: note.comment, rect },
          }),
        );
      };

      const rows = list.map((note, index) =>
        h('div', { key: note.id, className: 'dsh-cl-anno-row' }, [
          h('span', { key: 'index', className: 'dsh-cl-anno-index' }, `${index + 1}.`),
          h('div', { key: 'body', className: 'dsh-cl-anno-body' }, [
            h('div', { key: 'quoteLabel', className: 'dsh-cl-anno-label' }, t('anno.quoteLabel')),
            h('div', { key: 'quote', className: 'dsh-cl-anno-rowquote' }, note.quote),
            h('div', { key: 'commentLabel', className: 'dsh-cl-anno-label' }, t('anno.commentLabel')),
            h('div', { key: 'comment', className: 'dsh-cl-anno-comment' }, note.comment === '' ? '—' : note.comment),
          ]),
          h('div', { key: 'actions', className: 'dsh-cl-anno-rowActions' }, [
            h(
              'button',
              {
                key: 'edit',
                type: 'button',
                className: 'dsh-cl-anno-iconbutton',
                title: t('anno.edit'),
                'aria-label': t('anno.edit'),
                onClick: (event) => editAnnotation(note, event),
              },
              '✎',
            ),
            h(
              'button',
              {
                key: 'delete',
                type: 'button',
                className: 'dsh-cl-anno-iconbutton',
                title: t('anno.delete'),
                'aria-label': t('anno.delete'),
                onClick: () => removeAnnotation(note.id),
              },
              '🗑',
            ),
          ]),
        ]),
      );

      return h('div', { className: 'dsh-cl-anno-dock' }, [
        h(
          'div',
          {
            key: 'anchor',
            className: 'dsh-cl-anno-anchor',
            onMouseEnter: () => setOpen(true),
            onMouseLeave: () => setOpen(false),
          },
          [
            open
              ? h(
                  'div',
                  { key: 'pop-wrap', className: 'dsh-cl-anno-pop-wrap' },
                  h('div', { key: 'pop', className: 'dsh-cl-anno-pop', role: 'group' }, rows),
                )
              : null,
            h('div', { key: 'pill', className: 'dsh-cl-anno-pill' }, [
              h(
                'button',
                {
                  key: 'summary',
                  type: 'button',
                  className: 'dsh-cl-anno-summary',
                  'aria-expanded': open,
                  onFocus: () => setOpen(true),
                  onClick: () => setOpen(true),
                },
                [
                  h('span', { key: 'icon', className: 'dsh-cl-anno-icon' }, annotationIcon(13)),
                  h('span', { key: 'label' }, `${list.length} ${t('anno.count')}`),
                ],
              ),
              h(
                'button',
                {
                  key: 'clear',
                  type: 'button',
                  className: 'dsh-cl-anno-clear',
                  title: t('anno.clear'),
                  'aria-label': t('anno.clear'),
                  onClick: () => clearAnnotations(),
                },
                '×',
              ),
            ]),
          ],
        ),
      ]);
    }

    // ------------------------------------------------------------------
    // Configuration page (plugins.row.config).
    // ------------------------------------------------------------------

    function TurnCompleteToastSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const settings = React.useSyncExternalStore(subscribeSettings, getSettings);
      const [status, setStatus] = React.useState(undefined);
      const [permission, setPermission] = React.useState(notificationPermission);
      const fileRef = React.useRef(null);
      if (props.view === 'summary') return null;

      const applyPermission = (next) => {
        setPermission(next);
        if (next === 'granted' && getSettings().systemNotify === 'off') updateSettings({ systemNotify: 'hidden' });
      };

      const requestPermission = () => {
        if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return;
        try {
          const result = Notification.requestPermission(applyPermission);
          if (result !== null && typeof result.then === 'function') {
            result.then(applyPermission).catch(() => {});
          }
        } catch {
          /* permission request refused */
        }
      };

      const permissionHint = () => {
        switch (permission) {
          case 'granted':
            return t('settings.system.permission.granted');
          case 'denied':
            return t('settings.system.permission.denied');
          case 'unsupported':
            return t('settings.system.permission.unsupported');
          default:
            return t('settings.system.permission.default');
        }
      };

      const settingRow = (key, title, description, control) =>
        h('div', { key, className: 'dsh-tct-setting' }, [
          h('div', { key: 'text', className: 'dsh-tct-settingText' }, [
            h('span', { key: 'title', className: 'dsh-tct-settingTitle' }, title),
            description === undefined
              ? null
              : h('span', { key: 'desc', className: 'dsh-tct-settingDesc' }, description),
          ]),
          h('div', { key: 'control', className: 'dsh-tct-settingControl' }, control),
        ]);

      const chooseFile = () => {
        if (fileRef.current !== null) fileRef.current.click();
      };

      const uploadFile = async (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
        if (!type.startsWith('audio/')) {
          setStatus(t('settings.sound.invalid'));
          return;
        }
        if (file.size > MAX_SOUND_BYTES) {
          setStatus(t('settings.sound.tooBig'));
          return;
        }
        setStatus(t('settings.sound.uploading'));
        try {
          const response = await fetch(SOUND_ROUTE, {
            method: 'PUT',
            headers: { 'content-type': type, 'x-file-name': encodeURIComponent(file.name) },
            body: file,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = await response.json();
          updateSettings({
            soundSource: 'custom',
            soundVersion: typeof result.updatedAt === 'number' ? result.updatedAt : Date.now(),
            soundName: typeof result.name === 'string' && result.name !== '' ? result.name : file.name,
          });
          setStatus(undefined);
          playCustomSound(getSettings().soundVersion);
        } catch {
          setStatus(t('settings.sound.uploadFailed'));
        }
      };

      const statusText =
        status !== undefined
          ? status
          : settings.soundName !== ''
            ? `${t('settings.sound.current')}${settings.soundName}`
            : t('settings.sound.none');

      const holdOptions = HOLD_OPTIONS.includes(settings.holdSeconds)
        ? HOLD_OPTIONS
        : [...HOLD_OPTIONS, settings.holdSeconds].sort(
            (left, right) => (left === 0 ? Number.MAX_SAFE_INTEGER : left) - (right === 0 ? Number.MAX_SAFE_INTEGER : right),
          );

      return h('div', { className: 'dsh-tct-settings' }, [
        h('style', { key: 'style' }, CSS),
        settingRow('inApp', t('settings.inApp.title'), t('settings.inApp.desc'), [
          h(
            'button',
            {
              key: 'previewToast',
              type: 'button',
              className: 'dsh-tct-button',
              onClick: () => requestToastPreview(settings.holdSeconds),
            },
            t('settings.previewToast'),
          ),
          h('input', {
            key: 'toggle',
            type: 'checkbox',
            className: 'dsh-tct-checkbox',
            checked: settings.inAppToast,
            'aria-label': t('settings.inApp.title'),
            onChange: (event) => updateSettings({ inAppToast: event.target.checked }),
          }),
        ]),
        settingRow(
          'system',
          t('settings.system.title'),
          t('settings.system.desc'),
          h(
            'select',
            {
              className: 'dsh-tct-select',
              value: settings.systemNotify,
              'aria-label': t('settings.system.title'),
              onChange: (event) => updateSettings({ systemNotify: event.target.value }),
            },
            [
              h('option', { key: 'off', value: 'off' }, t('settings.system.off')),
              h('option', { key: 'hidden', value: 'hidden' }, t('settings.system.hidden')),
              h('option', { key: 'always', value: 'always' }, t('settings.system.always')),
            ],
          ),
        ),
        settings.systemNotify === 'off'
          ? null
          : h('div', { key: 'permission', className: 'dsh-tct-setting' }, [
              h('div', { key: 'text', className: 'dsh-tct-settingText' }, [
                h('p', { key: 'hint', className: 'dsh-tct-hint' }, permissionHint()),
              ]),
              h('div', { key: 'control', className: 'dsh-tct-settingControl' }, [
                h(
                  'button',
                  {
                    key: 'enable',
                    type: 'button',
                    className: 'dsh-tct-button',
                    disabled: permission === 'granted' || permission === 'unsupported',
                    onClick: requestPermission,
                  },
                  t('settings.system.permission.enable'),
                ),
              ]),
            ]),
        settingRow(
          'diffBadge',
          t('settings.diffBadge.title'),
          t('settings.diffBadge.desc'),
          h('input', {
            type: 'checkbox',
            className: 'dsh-tct-checkbox',
            checked: settings.diffBadge,
            'aria-label': t('settings.diffBadge.title'),
            onChange: (event) => updateSettings({ diffBadge: event.target.checked }),
          }),
        ),
        settingRow(
          'fileMenu',
          t('settings.fileMenu.title'),
          t('settings.fileMenu.desc'),
          h('input', {
            type: 'checkbox',
            className: 'dsh-tct-checkbox',
            checked: settings.fileMenu,
            'aria-label': t('settings.fileMenu.title'),
            onChange: (event) => updateSettings({ fileMenu: event.target.checked }),
          }),
        ),
        settingRow(
          'hold',
          t('settings.hold.title'),
          t('settings.hold.desc'),
          h(
            'select',
            {
              className: 'dsh-tct-select',
              value: String(settings.holdSeconds),
              'aria-label': t('settings.hold.title'),
              onChange: (event) => updateSettings({ holdSeconds: Number(event.target.value) }),
            },
            holdOptions.map((seconds) =>
              h(
                'option',
                { key: String(seconds), value: String(seconds) },
                seconds === 0 ? t('settings.hold.never') : `${seconds} ${t('settings.hold.seconds')}`,
              ),
            ),
          ),
        ),
        settingRow('sound', t('settings.sound.title'), t('settings.sound.desc'), [
          h(
            'button',
            {
              key: 'preview',
              type: 'button',
              className: 'dsh-tct-button',
              onClick: () => playSelectedSound(),
            },
            t('settings.sound.preview'),
          ),
          h('input', {
            key: 'toggle',
            type: 'checkbox',
            className: 'dsh-tct-checkbox',
            checked: settings.sound,
            'aria-label': t('settings.sound.title'),
            onChange: (event) => updateSettings({ sound: event.target.checked }),
          }),
        ]),
        settingRow('soundSource', t('settings.sound.sourceTitle'), t('settings.sound.sourceDesc'), [
          h(
            'select',
            {
              key: 'select',
              className: 'dsh-tct-select',
              value: settings.soundSource,
              'aria-label': t('settings.sound.title'),
              onChange: (event) =>
                updateSettings({ soundSource: event.target.value === 'custom' ? 'custom' : 'chime' }),
            },
            [
              h('option', { key: 'chime', value: 'chime' }, t('settings.sound.builtin')),
              h('option', { key: 'custom', value: 'custom' }, t('settings.sound.custom')),
            ],
          ),
          h(
            'button',
            { key: 'choose', type: 'button', className: 'dsh-tct-button', onClick: chooseFile },
            t('settings.sound.choose'),
          ),
          settings.soundSource === 'custom'
            ? h(
                'button',
                {
                  key: 'restore',
                  type: 'button',
                  className: 'dsh-tct-button',
                  onClick: () => {
                    updateSettings({ soundSource: 'chime', soundName: '' });
                    setStatus(undefined);
                  },
                },
                t('settings.sound.remove'),
              )
            : null,
          h('input', {
            key: 'file',
            ref: fileRef,
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: uploadFile,
          }),
        ]),
        h('p', { key: 'status', className: 'dsh-tct-hint' }, statusText),
      ]);
    }

    // ------------------------------------------------------------------
    // Icons.
    // ------------------------------------------------------------------

    function iconOf(tone) {
      const base = {
        width: 18,
        height: 18,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      };
      if (tone === 'error') {
        return h('svg', base, [
          h('circle', { key: 'circle', cx: 10, cy: 10, r: 7.6 }),
          h('path', { key: 'mark', d: 'M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2' }),
        ]);
      }
      if (tone === 'warning') {
        return h('svg', base, [
          h('circle', { key: 'circle', cx: 10, cy: 10, r: 7.6 }),
          h('path', { key: 'stem', d: 'M10 6.3v4.9' }),
          h('path', { key: 'dot', d: 'M10 13.7h.01' }),
        ]);
      }
      return h('svg', base, [
        h('circle', { key: 'circle', cx: 10, cy: 10, r: 7.6 }),
        h('path', { key: 'mark', d: 'M6.6 10.2l2.4 2.4 4.4-4.9' }),
      ]);
    }

    function closeIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M2.6 2.6l6.8 6.8M9.4 2.6L2.6 9.4' }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-interaction-optimize: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-interaction-optimize: en dictionary');

        /** Resolve the live event source of the session the main view retains. */
        const getSessionEventSource = (sessionId) => {
          const sessions = ctx.get('sessions');
          if (!sessions || typeof sessions.binding !== 'function') return undefined;
          const binding = sessions.binding(sessionId);
          return binding && binding.eventSource ? binding.eventSource : undefined;
        };

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: NS,
              order: 40,
              locale: NS,
              inject: () => ({ getSessionEventSource }),
            },
            TurnCompleteToast,
          ),
        );

        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: ROW_CONFIG_KEY,
              locale: NS,
            },
            TurnCompleteToastSettings,
          ),
        );

        // Diff badge above the composer, refreshed from the Host's workspace
        // changes record while a turn runs. Clicking it opens the same
        // `changes-review` pane the turn-tail card opens in the right Sidebar.
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: `${NS}-diff`,
              order: 12,
              locale: NS,
              inject: () => ({
                openChangesReview: (sessionId, seq, turn, index) => {
                  const sidebar = ctx.get('sidebarRight');
                  if (!sidebar || typeof sidebar.openResource !== 'function') return false;
                  if (typeof sessionId !== 'string' || !Number.isFinite(seq)) return false;
                  const address = `dsh-resource://changes-review/session/${encodeURIComponent(sessionId)}/${seq}/${
                    Number.isFinite(turn) ? turn : 1
                  }`;
                  const fileIndex = Number.isFinite(index) && index >= 0 ? index : 0;
                  sidebar.openResource(address, { params: { index: fileIndex } });
                  return true;
                },
              }),
            },
            DiffDock,
          ),
        );

        // Pending annotations pill, right above the composer.
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: `${NS}-annotations`,
              order: 13,
              locale: NS,
              inject: () => ({
                submitAnnotations: async (sessionId, text) => {
                  const sessions = ctx.get('sessions');
                  if (!sessions || typeof sessions.binding !== 'function') return false;
                  const binding = sessions.binding(sessionId);
                  const session = binding && binding.session;
                  if (!session || typeof session.prompt !== 'function') return false;
                  try {
                    const result = await session.prompt([{ type: 'text', text }], 'queue');
                    return result !== null && result !== undefined && result.ok === true;
                  } catch {
                    return false;
                  }
                },
              }),
            },
            AnnotationDock,
          ),
        );

        // Select-text toolbar and its annotation editor.
        ctx.effect(() => installSelectionToolbar(ctx.locale.bind(NS)), 'dsh-interaction-optimize: selection annotations');

        // Collapse sent annotation blocks into a `N 条注释` pill.
        ctx.effect(
          () => installSentAnnotationRenderer(ctx.locale.bind(NS)),
          'dsh-interaction-optimize: sent annotations',
        );

        // Right-click file links in the conversation: open with the default
        // application, reveal in the file manager, or pick another application.
        const currentSessionScope = () => {
          const sessions = ctx.get('sessions');
          if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined;
          const snapshot = sessions.list.getSnapshot();
          const byId = snapshot && snapshot.byId ? snapshot.byId : undefined;
          if (byId === undefined) return undefined;
          const row = Object.values(byId).find((item) => item && (item.retainedBy?.mainView ?? 0) > 0);
          if (row === undefined || row === null) return undefined;
          return {
            id: typeof row.id === 'string' ? row.id : typeof row.sessionId === 'string' ? row.sessionId : undefined,
            cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
          };
        };
        ctx.effect(
          () =>
            installFileContextMenu(
              () => getSettings().fileMenu !== false,
              currentSessionScope,
              ctx.locale.bind(NS),
            ),
          'dsh-interaction-optimize: file context menu',
        );

        // Numbered badges pinned to the annotated text.
        ctx.effect(() => {
          const update = () => renderAnnotationMarkers();
          const unsubscribe = subscribeAnnotations(update);
          window.addEventListener('scroll', update, true);
          window.addEventListener('resize', update);
          const timer = window.setInterval(update, 800);
          update();
          return () => {
            unsubscribe();
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
            window.clearInterval(timer);
            disposeAnnotationMarkers();
          };
        }, 'dsh-interaction-optimize: annotation markers');

        // Release the lazily created audio graph with this Client run.
        ctx.effect(
          () => () => {
            if (audioContext === undefined) return;
            try {
              void audioContext.close().catch(() => {});
            } catch {
              /* already closed */
            }
            audioContext = undefined;
          },
          'dsh-interaction-optimize: audio context',
        );
      },
    };
  },
});
