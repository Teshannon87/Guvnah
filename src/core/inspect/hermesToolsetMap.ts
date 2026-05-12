/**
 * Mapping from Hermes Agent tool names to the toolset key used in
 * `agent.disabled_toolsets` in /root/.hermes/config.yaml.
 *
 * This is the only granularity Hermes exposes for tool gating: you can disable
 * a whole toolset, but not individual tools within it. See `platform_toolsets`
 * in the Hermes config for the canonical groupings.
 *
 * Keep this list in sync with Hermes' platform_toolsets definitions when
 * upgrading.
 */
export const HERMES_TOOL_TO_TOOLSET: Record<string, string> = {
  // browser
  browser_back: "browser",
  browser_click: "browser",
  browser_console: "browser",
  browser_get_images: "browser",
  browser_navigate: "browser",
  browser_press: "browser",
  browser_scroll: "browser",
  browser_snapshot: "browser",
  browser_type: "browser",
  browser_vision: "browser",
  // clarify
  clarify: "clarify",
  // code_execution
  execute_code: "code_execution",
  // delegation
  delegate_task: "delegation",
  // file
  read_file: "file",
  write_file: "file",
  patch: "file",
  search_files: "file",
  // image_gen
  // (no example output above)
  // memory
  memory: "memory",
  // messaging
  send_message: "messaging",
  // session_search
  session_search: "session_search",
  // skills
  skill_manage: "skills",
  skill_view: "skills",
  skills_list: "skills",
  // terminal
  terminal: "terminal",
  process: "terminal",
  // todo
  todo: "todo",
  // tts
  text_to_speech: "tts",
  // vision
  video_analyze: "vision",
  vision_analyze: "vision",
  // web
  web_extract: "web",
  web_search: "web",
  // feishu (plugin)
  feishu_doc_read: "feishu",
  feishu_drive_add_comment: "feishu",
  feishu_drive_list_comment_replies: "feishu",
  feishu_drive_list_comments: "feishu",
  feishu_drive_reply_comment: "feishu",
};

export function toolsetFor(toolName: string): string | null {
  return HERMES_TOOL_TO_TOOLSET[toolName] ?? null;
}
