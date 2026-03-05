function generateToolCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getParameters(tool) {
  if ("parameters" in tool) return tool.parameters;
  if ("inputSchema" in tool) return tool.inputSchema;
  return undefined;
}

export function buildJsonToolSystemPrompt(systemPrompt, tools) {
  if (!tools || tools.length === 0) {
    return systemPrompt || "";
  }

  const parallelInstruction =
    "Only request one tool call at a time. Wait for tool results before asking for another tool.";

  const toolSchemas = tools.map((tool) => {
    const schema = getParameters(tool);
    return {
      name: tool.name,
      description: tool.description ?? "No description provided.",
      parameters: schema || { type: "object", properties: {} },
    };
  });

  const toolsJson = JSON.stringify(toolSchemas, null, 2);

  const instructionBody = `You are a helpful AI assistant with access to tools.

# Available Tools
${toolsJson}

# Tool Calling Instructions
${parallelInstruction}

To call a tool, output JSON in this exact format inside a \`\`\`tool_call code fence:

\`\`\`tool_call
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
\`\`\`

Tool responses will be provided in \`\`\`tool_result fences. Each line contains JSON like:
\`\`\`tool_result
{"id": "call_123", "name": "tool_name", "result": {...}, "error": false}
\`\`\`
Use the \`result\` payload (and treat \`error\` as a boolean flag) when continuing the conversation.

Important:
- Use exact tool and parameter names from the schema above
- Arguments must be a valid JSON object matching the tool's parameters
- You can include brief reasoning before or after the tool call
- If no tool is needed, respond directly without tool_call fences`;

  if (systemPrompt?.trim()) {
    return `${systemPrompt.trim()}\n\n${instructionBody}`;
  }

  return instructionBody;
}

function buildRegex(options) {
  const patterns = [];
  patterns.push("```tool[_-]?call\\s*([\\s\\S]*?)```");
  if (options.supportXmlTags) {
    patterns.push("<tool_call>\\s*([\\s\\S]*?)\\s*</tool_call>");
  }
  if (options.supportPythonStyle) {
    patterns.push("\\[(\\w+)\\(([^)]*)\\)\\]");
  }
  return new RegExp(patterns.join("|"), "gi");
}

export function parseJsonFunctionCalls(response, options = {}) {
  const mergedOptions = {
    supportXmlTags: true,
    supportPythonStyle: true,
    supportParametersField: true,
    ...options,
  };
  const regex = buildRegex(mergedOptions);

  const matches = Array.from(response.matchAll(regex));
  regex.lastIndex = 0;

  if (matches.length === 0) {
    return { toolCalls: [], textContent: response };
  }

  const toolCalls = [];
  let textContent = response;

  for (const match of matches) {
    const fullMatch = match[0];
    textContent = textContent.replace(fullMatch, "");

    try {
      if (mergedOptions.supportPythonStyle && match[0].startsWith("[")) {
        const pythonMatch = /\[(\w+)\(([^)]*)\)\]/.exec(match[0]);
        if (pythonMatch) {
          const [, funcName, pythonArgs] = pythonMatch;
          const args = {};

          if (pythonArgs && pythonArgs.trim()) {
            const argPairs = pythonArgs.split(",").map((s) => s.trim());
            for (const pair of argPairs) {
              const equalIndex = pair.indexOf("=");
              if (equalIndex > 0) {
                const key = pair.substring(0, equalIndex).trim();
                let value = pair.substring(equalIndex + 1).trim();
                if (
                  (value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))
                ) {
                  value = value.substring(1, value.length - 1);
                }
                args[key] = value;
              }
            }
          }

          toolCalls.push({
            toolCallId: generateToolCallId(),
            toolName: funcName,
            args,
          });
          continue;
        }
      }

      const innerContent = match[1] || match[2] || "";
      const trimmed = innerContent.trim();

      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const callsArray = Array.isArray(parsed) ? parsed : [parsed];

        for (const call of callsArray) {
          if (!call.name) continue;

          let args =
            call.arguments ||
            (mergedOptions.supportParametersField ? call.parameters : null) ||
            {};

          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              // keep as string
            }
          }

          toolCalls.push({
            toolCallId: call.id || generateToolCallId(),
            toolName: call.name,
            args,
          });
        }
      } catch {
        const lines = trimmed.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          try {
            const call = JSON.parse(line.trim());
            if (!call.name) continue;

            let args =
              call.arguments ||
              (mergedOptions.supportParametersField ? call.parameters : null) ||
              {};

            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                // keep as string
              }
            }

            toolCalls.push({
              toolCallId: call.id || generateToolCallId(),
              toolName: call.name,
              args,
            });
          } catch {
            continue;
          }
        }
      }
    } catch (error) {
      console.warn("Failed to parse JSON tool call:", error);
      continue;
    }
  }

  textContent = textContent.replace(/\n{2,}/g, "\n");

  return { toolCalls, textContent: textContent.trim() };
}

export function formatToolResults(results) {
  if (!results || results.length === 0) {
    return "";
  }

  const payloads = results.map((result) => {
    const payload = {
      name: result.toolName,
      result: result.result ?? null,
      error: Boolean(result.isError),
    };
    if (result.toolCallId) payload.id = result.toolCallId;
    return JSON.stringify(payload);
  });

  return `\`\`\`tool_result
${payloads.join("\n")}
\`\`\``;
}
