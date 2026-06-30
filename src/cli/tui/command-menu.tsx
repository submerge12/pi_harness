import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
	filterSlashCommands,
	shouldShowSlashCommandMenu,
	type SlashCommandMetadata,
} from "../commands.ts";

export interface CommandMenuProps {
	active: boolean;
	buffer: string;
	onComplete(command: SlashCommandMetadata): void;
	onDismiss(): void;
}

export function completeSlashCommand(command: SlashCommandMetadata): string {
	return `/${command.name} `;
}

export function CommandMenu({ active, buffer, onComplete, onDismiss }: CommandMenuProps): React.JSX.Element | null {
	const items = useMemo(() => filterSlashCommands(buffer), [buffer]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const menuVisible = active && shouldShowSlashCommandMenu(buffer);

	useEffect(() => {
		setSelectedIndex(0);
	}, [buffer]);

	useInput(
		(_input, key) => {
			if (!menuVisible) return;
			if (key.escape) {
				onDismiss();
				return;
			}
			if (items.length === 0) return;
			if (key.upArrow) {
				setSelectedIndex((index) => (index === 0 ? items.length - 1 : index - 1));
				return;
			}
			if (key.downArrow) {
				setSelectedIndex((index) => (index + 1) % items.length);
				return;
			}
			if (key.tab || key.return) onComplete(items[Math.min(selectedIndex, items.length - 1)]!);
		},
		{ isActive: menuVisible },
	);

	if (!menuVisible) return null;

	if (items.length === 0) {
		return (
			<Box paddingX={1}>
				<Text color="gray">No matching commands</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			{items.map((item, index) => (
				<Text key={item.name} color={index === selectedIndex ? "cyan" : undefined}>
					{index === selectedIndex ? ">" : " "} /{item.name}  {item.description}
				</Text>
			))}
		</Box>
	);
}
