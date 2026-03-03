[x] if it is from xiaohongshu, with one or multiple pictures, keep those pictures under a folder with the same name of the md file.
[x] after add this extension to chrome, it shows Create Your Telegram Bot workflow. After I updated it, and the extension icon in the menu bar shows a block badge. If I click the icon, it ask me to do the setup again. After that, it will work. fix it.
[x] add a new function, in chrome, if i open, and paste a url, it will save it as md file. so in the ui, it has a area, saying paste here, border is dashed, the user can right click and paste, or use keyboard shortcut to paste, without confirm button, it will do the save action.
![alt text](image.png)
[x] add a funtion, 做右键菜单 Save to Markdown Vault
需要加 contextMenus 权限（你现在还没有：manifest.json (line 6)），然后在 background.js 里监听菜单点击并调用现有 save_url 流程。 so, 右键菜单 Save to Markdown Vault will be an option, and user can turn on/ off in the setting.

[x] 如果发的是图片，命名，date+name.jpg
[x] copy paste url, bug, it will save twice.
[x] 显示last pull和next pull的时间
[x] https://builders.ramp.com/post/why-we-built-our-background-agent this site can't be extracted, why?
[x] - **Files downloaded as-is** — binary content saved directly, no processing. (previously I want file skip, but now I change my mind)
        - update, we want file to save as is. and also a md file to record the metadata of the file, and name of the file
        - media-extraction-plan.md, update this file and include the change.
[x] update README.md, it should be readable by  ai agent. have all the info for ai agent to run the project. remove unusefull info to save token for those agents.
[x]         <div id="paste-label" class="paste-label">Paste a URL to save it</div>, here add function, so user can paste a url, or paste a screenshot image in clipboard, or paste a text.
[x] we just tried this url, https://x.com/pirrer/status/2028477493993488504, it is x, and when open, it opens an article, but my code can't extract it. fix it.