# Folder Permission Loss: Behavior Answer

## Question
If folder permission is lost, what happens when new Telegram messages arrive?  
Will messages save to the folder after permission is restored?

## Answer
Yes, they can save after permission is restored, with one important limit.

- When folder permission is missing, `getDirHandle()` returns `null`, sets `fs_permission_needed = true`, and `poll()` exits early.
- Because `poll()` exits before `getUpdates`, `last_update_id` does not advance.
- That means Telegram messages stay queued and are not consumed while permission is missing.
- After permission is granted again, polling resumes with the previous `last_update_id`, so queued messages are fetched and then saved.

## Limit
- Telegram only keeps updates for a limited time window (commonly up to about 24 hours in this project’s assumptions).
- If permission is restored after that window, older queued messages may no longer be available from Telegram and cannot be saved automatically.
