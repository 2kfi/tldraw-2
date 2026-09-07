# UI/UX & Interactive Testing Rules

When asked to test a site or page:
1. Open the page using `agent-browser open <URL>`.
2. Get the accessibility tree using `agent-browser snapshot -i`.
3. Systematically test ALL interactive elements:
   - Click every button (`agent-browser click @ref`).
   - Open and close menus, dropdowns, and modals.
   - Submit forms with valid and invalid inputs.
4. Catch Non-Visual UI/UX Failures:
   - **Broken Flows:** Check if clicking a button results in an unexpected state or does nothing.
   - **Console Errors:** Run dev logs checks for uncaught JS exceptions or 404/500 API calls upon user action.
   - **Accessibility (a11y) Violations:** Flag buttons missing accessible labels/aria-attributes, unnavigable keyboard focus, or broken tab order.
   - **Dead Links:** Verify all navigation links route to valid endpoints.
