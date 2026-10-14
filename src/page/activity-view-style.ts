/** Approved Teams-style bar and agent indicators; scoped to the view shadow root. */
export const ACTIVITY_VIEW_STYLE = String.raw`
:host{font:13px "Segoe UI",system-ui,sans-serif;color:#fff;--red:235,67,74}
*{box-sizing:border-box}[hidden]{display:none!important}
[data-frame]{position:absolute;inset:var(--bar-height,54px) 0 0;border:0;box-shadow:inset 0 0 28px 12px rgba(var(--red),.36);animation:breathe 4s ease-in-out infinite;pointer-events:none}
[data-panel]{position:absolute;inset:0 0 auto;min-height:54px;display:flex;align-items:center;gap:18px;padding:10px 18px;background:#464775;border-bottom:1px solid #6264a7;pointer-events:auto}
[data-brand]{display:flex;align-items:center;gap:10px;white-space:nowrap;font-weight:650;font-size:14px;letter-spacing:-.2px}
[data-dot]{width:8px;height:8px;border-radius:50%;background:#ef5058;animation:pulse 3s ease-in-out infinite}
[data-status]{color:#e3e3f1;border-left:1px solid #ffffff30;padding-left:18px}
button{font:inherit;font-weight:550;color:#fff;background:#6264a7;border:1px solid #9293c7;border-radius:4px;padding:6px 13px;cursor:pointer;display:flex;align-items:center;gap:7px}
button:hover{background:#7577b8}button:focus-visible{outline:2px solid #e2e2f6;outline-offset:3px}button:disabled{opacity:.5;cursor:default}button svg{flex:none}
[data-action=cancel]{margin-left:auto;background:transparent;border-color:#ffffff50}
[data-action=cancel]:hover{background:#7577b8}
[data-cursor]{position:absolute;width:30px;height:32px;filter:drop-shadow(0 0 2px #b8baffaa) drop-shadow(0 0 7px #7f82df66);pointer-events:none}
:host(:not([data-state=open])) [data-frame]{animation:none;box-shadow:inset 0 0 18px rgba(var(--red),.08)}
:host(:not([data-state=open])) [data-dot]{animation:none;background:#b5b5cc}
@keyframes breathe{0%,100%{box-shadow:inset 0 0 28px 12px rgba(var(--red),.36)}50%{box-shadow:inset 0 0 60px 16px rgba(var(--red),.52)}}
@keyframes pulse{0%,100%{box-shadow:0 0 0 1px #ef50581a,0 0 5px #ef505860}50%{box-shadow:0 0 0 5px #ef50583d,0 0 12px #ef505880}}
@media(prefers-reduced-motion:reduce){[data-frame],[data-dot]{animation:none}}
@media(max-width:520px){[data-panel]{gap:10px;padding:10px 12px;flex-wrap:wrap}[data-status]{order:4;flex-basis:100%;border:0;padding:0;font-size:12px}[data-brand]{margin-right:4px}}
`;
