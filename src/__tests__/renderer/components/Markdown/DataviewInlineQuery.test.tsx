import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import {
	createDataviewInlineCodeRenderer,
	parseDataviewInlineQuery,
} from '../../../../renderer/components/Markdown/components/DataviewInlineQuery';
import {
	DataviewDocumentContext,
	type DataviewDocumentScope,
} from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import {
	createMarkdownComponents,
	REMARK_GFM_PLUGINS,
} from '../../../../renderer/utils/markdownConfig';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { Link, toWireValue, type DataviewInlineResult } from '../../../../shared/dataview';
import { mockTheme } from '../../../helpers/mockTheme';

const NOTE = '/vault/People/Ada.md';

function scope(overrides: Partial<DataviewDocumentScope> = {}): DataviewDocumentScope {
	return { filePath: NOTE, agentId: 'agent-1', openLink: vi.fn(), ...overrides };
}

function respond(result: DataviewInlineResult) {
	vi.mocked(window.maestro.dataview.queryInline).mockResolvedValue({
		root: '/vault',
		sshRemoteId: null,
		revision: 1,
		path: 'People/Ada.md',
		result,
	});
}

function renderNote(markdown: string, doc: DataviewDocumentScope | null = scope()) {
	const note = (
		<ReactMarkdown
			remarkPlugins={REMARK_GFM_PLUGINS}
			components={createMarkdownComponents({
				theme: mockTheme,
				renderInlineCode: createDataviewInlineCodeRenderer(mockTheme),
			})}
		>
			{markdown}
		</ReactMarkdown>
	);
	return render(
		doc ? (
			<DataviewDocumentContext.Provider value={doc}>{note}</DataviewDocumentContext.Provider>
		) : (
			note
		)
	);
}

function setDataviewEnabled(enabled: boolean) {
	useSettingsStore.setState((state) => ({
		encoreFeatures: { ...state.encoreFeatures, dataview: enabled },
	}));
}

describe('parseDataviewInlineQuery', () => {
	it('takes the expression after the = prefix', () => {
		expect(parseDataviewInlineQuery('= this.file.name')).toBe('this.file.name');
		expect(parseDataviewInlineQuery('=date(today)')).toBe('date(today)');
	});

	it('leaves other spans alone', () => {
		expect(parseDataviewInlineQuery('this.file.name')).toBeNull();
		expect(parseDataviewInlineQuery('$= dv.current()')).toBeNull();
		expect(parseDataviewInlineQuery('=  ')).toBeNull();
	});
});

describe('DataviewInlineQuery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setDataviewEnabled(true);
	});

	afterEach(() => {
		setDataviewEnabled(false);
	});

	it('renders the value of an inline query in place of the code span', async () => {
		respond({ kind: 'value', value: toWireValue('Ada Lovelace') });
		const { container } = renderNote('Name: `= this.file.name` and `plain`.');

		await screen.findByText('Ada Lovelace');
		expect(window.maestro.dataview.queryInline).toHaveBeenCalledWith({
			filePath: NOTE,
			expression: 'this.file.name',
			agentId: 'agent-1',
		});
		expect(container.querySelector('[data-dataview-inline]')?.textContent).toBe('Ada Lovelace');
		expect(container.querySelector('code')?.textContent).toBe('plain');
	});

	it('shows the source dimmed while the value is on its way', () => {
		const { container } = renderNote('`= this.file.name`');

		const placeholder = container.querySelector('[data-dataview-inline-placeholder]');
		expect(placeholder?.textContent).toBe('= this.file.name');
	});

	it('renders a link value that opens through the surface', async () => {
		const openLink = vi.fn();
		respond({ kind: 'value', value: toWireValue(Link.file('People/Grace.md')) });
		renderNote('`= this.Connection`', scope({ openLink }));

		(await screen.findByText('Grace')).click();
		expect(openLink).toHaveBeenCalledWith('/vault/People/Grace.md', { openInNewTab: false });
	});

	it('shows an evaluation error inline with the Dataview text', async () => {
		respond({ kind: 'error', message: 'No implementation found for "nope"' });
		const { container } = renderNote('`= nope()`');

		await waitFor(() =>
			expect(container.querySelector('[data-dataview-inline-error]')?.textContent).toBe(
				`Dataview (for inline query 'nope()'): No implementation found for "nope"`
			)
		);
	});

	it('keeps the span as code outside a Dataview surface or with the Encore Feature off', () => {
		const { container, unmount } = renderNote('`= this.file.name`', null);
		expect(container.querySelector('code')?.textContent).toBe('= this.file.name');
		unmount();

		setDataviewEnabled(false);
		const second = renderNote('`= this.file.name`');
		expect(second.container.querySelector('code')?.textContent).toBe('= this.file.name');
		expect(window.maestro.dataview.queryInline).not.toHaveBeenCalled();
	});
});
