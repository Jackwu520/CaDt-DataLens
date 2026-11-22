"""Find tool — locate interactive elements by name and act on them (local patch).

Added in 0.8.9+p2. Why not CSS selectors / CDP: Chrome 136+ refuses to open
--remote-debugging-port on the default user-data-dir, so CDP would require a
separate profile and lose the user's logged-in session. Matching on the visible
name covers the common case at zero cost and without restarting the browser.
"""

from mcp.types import ToolAnnotations
from windows_mcp.desktop.utils import as_bool as _as_bool
from windows_mcp.infrastructure import with_analytics
from fastmcp import Context


def register(mcp, *, get_desktop, get_analytics):
    @mcp.tool(
        name="Find",
        description=(
            "Locate interactive elements by their visible name/label and act on them, without a "
            "Snapshot round-trip or guessing coordinates. Keywords: find, locate, search element, "
            "click button by text, fill field by label. query matches the control's name as a "
            "case-insensitive substring by default (set exact=true for a full match, regex=true for "
            "a regular expression). action='list' (default) returns the matches with coordinates; "
            "'click' activates the first match (nth selects others) and clicks its center, clicking "
            "twice when it belongs to a background window so the click actually lands; 'type' does "
            "the same then types text into it. Set window to a title regex to limit the search to one "
            "window when many are open."
        ),
        annotations=ToolAnnotations(
            title="Find",
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    @with_analytics(get_analytics(), "Find-Tool", run_sync_in_thread=False)
    def find_tool(
        query: str,
        action: str = "list",
        text: str | None = None,
        nth: int = 0,
        exact: bool | str = False,
        regex: bool | str = False,
        window: str | None = None,
        limit: int = 20,
        ctx: Context = None,
    ) -> str:
        desktop = get_desktop()
        exact = _as_bool(exact, "exact")
        regex = _as_bool(regex, "regex")
        action = (action or "list").strip().lower()
        if action not in ("list", "click", "type"):
            raise ValueError("action must be list, click or type")
        if action == "type" and text is None:
            raise ValueError("action='type' requires text")
        matches = desktop.find_elements(
            query,
            regex=regex,
            exact=exact,
            window=window,
            limit=max(1, min(int(limit), 50)),
        )
        if not matches:
            return f"No interactive element matches {query!r}" + (
                f" in window {window!r}" if window else ""
            ) + ". Try a shorter query, regex=true, or call Snapshot to see the names."
        if action == "list":
            lines = [f"{len(matches)} match(es) for {query!r}:"]
            for index, node in enumerate(matches):
                lines.append(
                    f"  [{index}] {node.name!r} <{node.control_type}> "
                    f"at ({int(node.center.x)},{int(node.center.y)})"
                    + (f" in {node.window_name!r}" if node.window_name else "")
                )
            return "\n".join(lines)

        index = max(0, min(int(nth), len(matches) - 1))
        target = matches[index]
        note = desktop.activate_element(target)
        if action == "type":
            typed = desktop.type_focused(text, press_enter=False)
            return f"Typed into {target.name!r}: {note}" + (f" {typed}" if typed else "")
        return note


