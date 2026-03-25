# Prompt Management

This directory contains model prompts extracted from the Viber codebase for easy management and updates.

## File Structure

- `system_prompt.md` - Default system prompt for the coding agent
- `tool_results_template.md` - Template for presenting tool results to the agent

## How to Update

### Model Prompts (Dynamic Loading)
Model prompts are automatically loaded from the Markdown files in this directory at application startup. To update a prompt:

1. Edit the corresponding Markdown file in this directory
2. Restart the application for changes to take effect

The application will automatically use the updated prompts on next startup. If a prompt file cannot be loaded, the application will use a built-in fallback and log a warning.

### Other Messages (UI, Errors, CLI Outputs)
All other text messages are centralized in `src/constants.ts` as static constants. Edit that file to change:
- Error messages and usage instructions
- CLI output messages for single-task mode
- Interactive UI text and labels
- Internal agent messages

## Template Variables

Model prompts may contain template variables enclosed in `{}`:
- `{resultBlob}` - Tool results concatenated

Other templates in `src/constants.ts` use function parameters for variable substitution.

## Integration

Prompts and messages are now separated for cleaner management:

1. **Model Prompts**: Managed by `src/prompts.ts`, dynamically loaded from Markdown files in this directory at application startup.

2. **Other Messages**: Managed by `src/constants.ts`, containing static constants for UI labels, error messages, CLI outputs, and agent messages.

To update any text in the application:
1. For model prompts: Edit the Markdown file in this directory and restart the application
2. For other messages: Edit the corresponding constant or function in `src/constants.ts` and rebuild the application

## Import Usage

Import model prompts from `src/prompts.ts` and other messages from `src/constants.ts`:

```typescript
// Model prompts
import { SYSTEM_PROMPT, TOOL_RESULTS_TEMPLATE, formatToolResults } from './prompts.js';

// Other messages
import {
  ERROR_MISSING_API_KEY,
  USAGE_INSTRUCTIONS,
  UI_LABELS,
  UI_TIPS,
  getToolCallSummary,
} from './constants.js';
```