import React from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { filterSlashCommands, type ReplHarness } from "../commands.ts";
import { CommandMenu } from "./command-menu.tsx";
import {
	PermissionPromptView,
	type TuiPermissionController,
	usePermissionSnapshot,
} from "./permission.tsx";
import { useHarness } from "./use-harness.ts";

export interface AppProps {
	harness: ReplHarness;
	permissionController: TuiPermissionController;
}

function toneColor(tone: string): "cyan" | "green" | "red" | "gray" | undefined {
	if (tone === "user") return "cyan";
	if (tone === "assistant") return "green";
	if (tone === "error") return "red";
	if (tone === "system") return "gray";
	return undefined;
}

export function App({ harness, permissionController }: AppProps): React.JSX.Element {
	const { exit } = useApp();
	const permission = usePermissionSnapshot(permissionController);
	const inputLocked = Boolean(permission.request);
	const session = useHarness(harness, { onExit: () => exit() });

	useInput(
		(input, key) => {
			if (inputLocked) return;
			if (key.ctrl && input === "c") void session.abortOrExit();
			if (input === "\u0004") session.exitNow();
		},
		{ isActive: !inputLocked },
	);

	return (
		<Box flexDirection="column">
			<Static items={session.transcript}>
				{(item) => (
					<Text key={item.id} color={toneColor(item.tone)}>
						{item.text}
					</Text>
				)}
			</Static>

			{session.renderState.liveAssistantText ? (
				<Box paddingX={1}>
					<Text>{session.renderState.liveAssistantText}</Text>
				</Box>
			) : null}

			{session.renderState.toolLines.slice(-2).map((tool) => (
				<Text key={`${tool.id}-${tool.text}`} color={tool.tone === "error" ? "red" : "gray"}>
					{tool.text}
				</Text>
			))}

			{session.renderState.noticeLines.slice(-2).map((notice) => (
				<Text key={notice} color="yellow">
					{notice}
				</Text>
			))}

			{session.renderState.footerText ? <Text color="gray">{session.renderState.footerText}</Text> : null}
			<PermissionPromptView controller={permissionController} onCancel={session.exitNow} />

			<CommandMenu
				active={session.commandMenuOpen}
				buffer={session.input}
				onComplete={session.completeCommand}
				onDismiss={session.dismissCommandMenu}
			/>

			<Box borderStyle="single" paddingX={1}>
				<Text color={session.busy ? "yellow" : "cyan"}>{session.busy ? "..." : ">"}</Text>
				<Text> </Text>
				<TextInput
					focus={!inputLocked && !session.busy}
					value={session.input}
					onChange={session.setInput}
					onSubmit={(value) => {
						if (session.commandMenuOpen) {
							if (filterSlashCommands(value).length > 0) return;
							session.submit(value);
							return;
						}
						session.submit(value);
					}}
					placeholder="Ask pi-harness"
					showCursor
				/>
			</Box>
		</Box>
	);
}
