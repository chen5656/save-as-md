[x] if it is from xiaohongshu, with one or multiple pictures, keep those pictures under a folder with the same name of the md file.
[x] after add this extension to chrome, it shows Create Your Telegram Bot workflow. After I updated it, and the extension icon in the menu bar shows a block badge. If I click the icon, it ask me to do the setup again. After that, it will work. fix it.
[x] add a new function, in chrome, if i open, and paste a url, it will save it as md file. so in the ui, it has a area, saying paste here, border is dashed, the user can right click and paste, or use keyboard shortcut to paste, without confirm button, it will do the save action.
![alt text](image.png)
[x] add a funtion, add right click menu "Save to Markdown Vault".  Save to Markdown Vault will be an option, and user can turn on/ off in the setting.

[x] https://builders.ramp.com/post/why-we-built-our-background-agent this site can't be extracted, why?
[x] - **Files downloaded as-is** — binary content saved directly, no processing. (previously I want file skip, but now I change my mind)
        - update, we want file to save as is. and also a md file to record the metadata of the file, and name of the file
        - media-extraction-plan.md, update this file and include the change.
[x] update README.md, it should be readable by  ai agent. have all the info for ai agent to run the project. remove unusefull info to save token for those agents.
[x]         <div id="paste-label" class="paste-label">Paste a URL to save it</div>, here add function, so user can paste a url, or paste a screenshot image in clipboard, or paste a text.
[x] we just tried this url, https://x.com/pirrer/status/2028477493993488504, it is x, and when open, it opens an article, but my code can't extract it. fix it.


/// not working


  What was happening:
  1. Tab opens at x.com/pirrer/status/...
  2. X's SPA renders the tweet — body is just https://t.co/1pnK0PqBtU
  3. Tweet extraction found div[data-testid="tweetText"] with the t.co URL as text → text = "https://t.co/1pnK0PqBtU"
  4. contentMarkdown = author metadata + URL → non-empty → returned as the "article" content
  5. Saved: just author info + bare URL ← the bug

  What happens now:
  1. Tweet extraction runs the same way, gets text = "https://t.co/1pnK0PqBtU"
  2. New check: textWithoutUrls = "", no images, no external links → returns null
  3. Falls through to note extraction
  4. Note extraction checks window.location.pathname in the tab — if X's SPA navigated to /i/article/..., tries [data-testid="article"], [role="article"], article, main → returns
  article text
  5. If still on status URL, Readability runs on the live DOM (which now has the article card loaded), then CSS selector fallback → main / article picks up content



///