/* eslint-disable obsidianmd/no-static-styles-assignment */
import { App, Modal, Notice, Plugin, TFile, PluginSettingTab, Setting, Editor, requestUrl, addIcon } from 'obsidian';
import * as OCL from 'openchemlib';

const chemSearchIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
    <circle cx="11" cy="11" r="3"></circle>
    <line x1="16" y1="16" x2="13.14" y2="13.14"></line>
</svg>`;

interface ChemSearchSettings {
    msDecimals: number;
    smilesPasteFormat: string;
    inventoryFolder: string;
}

const DEFAULT_SETTINGS: ChemSearchSettings = {
    msDecimals: 4,
    smilesPasteFormat: "```smiles\n{SMILES}\n```\n",
    inventoryFolder: "Chemical_Inventory"
};

const EXACT_MASSES: Record<string, number> = {
    C: 12.000000, H: 1.007825, N: 14.003074, O: 15.994915,
    F: 18.998403, Cl: 34.968853, Br: 78.918337, I: 126.904473,
    S: 31.972071, P: 30.973762, B: 10.012937, Si: 27.976927
};

const AVERAGE_MASSES: Record<string, number> = {
    C: 12.011, H: 1.008, N: 14.007, O: 15.999,
    F: 18.998, Cl: 35.45, Br: 79.904, I: 126.90,
    S: 32.06, P: 30.974, B: 10.81, Si: 28.085
};

interface ChemEditAPI {
    openEditor(initial: string, type: string, cb: (result: string) => Promise<void>): void;
    renderStructure(query: string, w: number, h: number): Promise<HTMLElement | null>;
}

interface ChemEditPluginInstance {
    api: ChemEditAPI;
}

interface ObsidianAppWithPlugins extends App {
    plugins: {
        plugins: Record<string, unknown>;
    };
}

export default class ChemSearchPlugin extends Plugin {
    settings!: ChemSearchSettings; 
    isSearching = false; 

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new ChemSearchSettingTab(this.app, this));
        addIcon('chemsearch-hex', chemSearchIcon);

        this.addRibbonIcon('chemsearch-hex', 'ChemSearch Toolkit', () => {
            this.openSearchModal();
        });

        this.addCommand({
            id: 'open-master-search',
            name: 'Search Chemical Inventory & Vault',
            icon: 'chemsearch-hex',
            callback: () => { new MasterSearchModal(this.app, this).open(); }
        });

        this.addCommand({
            id: 'calculate-ms',
            name: 'Calculate Exact Mass (MS) from SMILES (Offline)',
            icon: 'calculator',
            callback: () => {
                new TextInputModal(this.app, "Enter SMILES for MS Calculation:", (smiles) => {
                    this.calculateMSOffline(smiles);
                }).open();
            }
        });

        this.addCommand({
            id: 'calculate-elemental-analysis',
            name: 'Calculate Elemental Analysis (%CHNOS) (Offline)',
            icon: 'pie-chart',
            editorCallback: (editor: Editor) => {
                new TextInputModal(this.app, "Enter SMILES for Elemental Analysis:", (smiles) => {
                    this.calculateEAOffline(smiles, editor);
                }).open();
            }
        });

        this.addCommand({
            id: 'generate-experimental-boilerplate',
            name: 'Generate Experimental Section Boilerplate (Offline)',
            icon: 'file-text',
            editorCallback: (editor: Editor) => {
                new TextInputModal(this.app, "Enter SMILES to generate Experimental Boilerplate:", (smiles) => {
                    this.generateBoilerplateOffline(smiles, editor);
                }).open();
            }
        });

        this.addCommand({
            id: 'calculate-electrolysis',
            name: 'Calculate Electrolysis & Faradaic Efficiency (Offline)',
            icon: 'zap',
            editorCallback: (editor: Editor) => {
                new ElectrolysisModal(this.app, editor).open();
            }
        });

        this.addCommand({
            id: 'add-to-inventory',
            name: 'Add Chemical to Inventory',
            icon: 'archive',
            callback: () => {
                new InventoryModal(this.app, this).open();
            }
        });
        
        this.addCommand({
            id: 'search-external-databases',
            name: 'Search External Databases (Scholar, Reaxys, etc.)',
            icon: 'search',
            callback: () => {
                new ExternalDatabaseModal(this.app).open();
            }
        });
    }

    getOfflineProperties(smiles: string) {
        try {
            const mol = OCL.Molecule.fromSmiles(smiles);
            const formula = mol.getMolecularFormula().formula;
            
            const elementRegex = /([A-Z][a-z]?)([0-9]*)/g;
            let match: RegExpExecArray | null;
            const counts: Record<string, number> = {};
            
            while ((match = elementRegex.exec(formula)) !== null) {
                if (match[1]) {
                    const elem = match[1];
                    const count = match[2] ? parseInt(match[2], 10) : 1;
                    counts[elem] = (counts[elem] || 0) + count;
                }
            }
            
            let exactMass = 0;
            let mw = 0;
            
            for (const elem in counts) {
                const count = counts[elem] || 0;
                exactMass += (EXACT_MASSES[elem] || AVERAGE_MASSES[elem] || 0) * count;
                mw += (AVERAGE_MASSES[elem] || 0) * count;
            }
            
            return { formula, mw, exactMass, counts };
        } catch {
            return null;
        }
    }

    calculateMSOffline(smiles: string) {
        const props = this.getOfflineProperties(smiles);
        if (!props) {
            new Notice("Invalid SMILES structure.");
            return;
        }
        const exact = props.exactMass.toFixed(this.settings.msDecimals);
        new FormattedNoticeModal(this.app, "Offline MS Calculation", props.formula, props.mw.toFixed(3), exact).open();
    }

    calculateEAOffline(smiles: string, editor?: Editor) {
        const props = this.getOfflineProperties(smiles);
        if (!props) {
            new Notice("Invalid SMILES structure.");
            return;
        }
        const eaParts: string[] = [];
        const presentElems = Object.keys(props.counts);
        const orderedElems = ['C', 'H', 'N'].filter(e => presentElems.includes(e)).concat(presentElems.filter(e => !['C', 'H', 'N'].includes(e)).sort());
        
        for (const elem of orderedElems) {
            const weight = AVERAGE_MASSES[elem];
            const count = props.counts[elem] || 0;
            
            if (weight && count > 0) {
                const pct = ((count * weight) / props.mw) * 100;
                eaParts.push(`${elem}, ${pct.toFixed(2)}`);
            }
        }
        const eaString = `Anal. Calcd for ${props.formula}: ${eaParts.join('; ')}. Found: [  ]`;
        new EaResultsModal(this.app, props.formula, props.mw, eaString, editor).open();
    }

    generateBoilerplateOffline(smiles: string, editor: Editor) {
        const props = this.getOfflineProperties(smiles);
        if (!props) {
            new Notice("Invalid SMILES structure.");
            return;
        }
        const massPlusH = (props.exactMass + 1.007276).toFixed(this.settings.msDecimals);
        const massPlusNa = (props.exactMass + 22.989769).toFixed(this.settings.msDecimals);
        
        const eaParts: string[] = [];
        for (const elem of Object.keys(props.counts).sort()) {
            const weight = AVERAGE_MASSES[elem];
            const count = props.counts[elem] || 0;
            
            if (weight && count > 0) {
                const pct = ((count * weight) / props.mw) * 100;
                eaParts.push(`${elem}, ${pct.toFixed(2)}`);
            }
        }
        const eaText = `Anal. Calcd for ${props.formula}: ${eaParts.join('; ')}. Found: [  ]`;

        let boilerplate = `**Compound Name / Code**\n`;
        boilerplate += `Yield: XX% (XX mg, XX mmol) as a [color] [state].\n\n`;
        boilerplate += `**${props.formula}** (MW: ${props.mw.toFixed(2)} g/mol)\n\n`;
        boilerplate += `${this.settings.smilesPasteFormat.replace('{SMILES}', smiles)}\n\n`;
        boilerplate += `**1H NMR** (400 MHz, CDCl3) $\\delta$ \n\n`;
        boilerplate += `**13C NMR** (101 MHz, CDCl3) $\\delta$ \n\n`;
        boilerplate += `**HRMS (ESI-TOF)** m/z: [M+H]+ Calcd for ${props.formula}H+ ${massPlusH}; Found [ ]. ([M+Na]+ Calcd ${massPlusNa})\n\n`;
        boilerplate += `**${eaText}**\n\n---\n`;

        new BoilerplateModal(this.app, boilerplate, editor).open();
    }

    getChemEdit(): ChemEditPluginInstance | null {
        const obsidianApp = this.app as ObsidianAppWithPlugins;
        const plugins = obsidianApp.plugins.plugins;
        
        const isChemEditPlugin = (plug: unknown): plug is ChemEditPluginInstance => {
            if (typeof plug === 'object' && plug !== null) {
                const api = (plug as Record<string, unknown>).api;
                return typeof api === 'object' && api !== null && typeof (api as Record<string, unknown>).openEditor === 'function';
            }
            return false;
        };

        const targets = ['chemedit-universal', 'obsidian-chemedit-universal', 'chemedit', 'obsidian-chemedit'];
        for (const target of targets) {
            const plug = plugins[target];
            if (isChemEditPlugin(plug)) return plug;
        }
        
        for (const key in plugins) {
            const plug = plugins[key];
            if (isChemEditPlugin(plug)) {
                return plug;
            }
        }
        
        return null;
    }

    async executeStructureSearchSafe(querySmiles: string, chemEdit: ChemEditPluginInstance) {
        if (!querySmiles || this.isSearching) return;
        this.isSearching = true;
        try {
            new Notice("Running structural search (this may take a moment)...");
            await this.performSubstructureSearch(querySmiles, chemEdit);
        } catch (e) {
            console.error("Search failed", e);
        } finally {
            window.setTimeout(() => { this.isSearching = false; }, 500);
        }
    }

    openSearchModal() {
        const chemEdit = this.getChemEdit();
        if (!chemEdit) {
            new TextInputModal(this.app, "A Structure Drawing plugin (ChemEdit or ChemEdit Universal) was not found. Enter SMILES query manually:", (smiles) => {
                void this.executeStructureSearchSafe(smiles, null as unknown as ChemEditPluginInstance);
            }).open();
            return;
        }

        chemEdit.api.openEditor("", "smiles", async (querySmiles: string) => {
            await this.executeStructureSearchSafe(querySmiles, chemEdit);
        });
    }

    async performSubstructureSearch(querySmiles: string, chemEdit: ChemEditPluginInstance) {
        const matchingFiles: { file: TFile, matchedSmiles: string[] }[] = [];
        try {
            const queryMol = OCL.Molecule.fromSmiles(querySmiles);
            queryMol.setFragment(true);
            const searcher = new OCL.SSSearcher();
            searcher.setFragment(queryMol);

            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const foundSmiles = this.extractSmilesFromMarkdown(content);
                const fileMatches: string[] = [];

                for (const smiles of foundSmiles) {
                    try {
                        const targetMol = OCL.Molecule.fromSmiles(smiles);
                        searcher.setMolecule(targetMol);
                        if (searcher.isFragmentInMolecule()) fileMatches.push(smiles);
                    } catch {
                        continue;
                    }
                }
                if (fileMatches.length > 0) matchingFiles.push({ file, matchedSmiles: fileMatches });
            }
            new SearchResultsModal(this.app, querySmiles, matchingFiles, chemEdit).open();
        } catch {
            new Notice("Error processing query. Ensure it is a valid SMILES structure.");
        }
    }

    async performMetadataSearch(query: string) {
        if (!query) return;
        const matchingFiles: TFile[] = [];
        const files = this.app.vault.getMarkdownFiles();
        const lowerQuery = query.toLowerCase();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            let matched = false;
            if (file.name.toLowerCase().includes(lowerQuery)) matched = true;
            if (cache?.frontmatter) {
                const fm = cache.frontmatter;
                const name = fm['name'];
                if (typeof name === 'string' && name.toLowerCase().includes(lowerQuery)) matched = true;
                
                const cas = fm['cas'];
                if (typeof cas === 'string' && cas.toLowerCase().includes(lowerQuery)) matched = true;
                
                const barcode = fm['barcode'];
                if (typeof barcode === 'string' && barcode.toLowerCase().includes(lowerQuery)) matched = true;
            }
            if (matched) matchingFiles.push(file);
        }
        
        new MetadataSearchResultsModal(this.app, query, matchingFiles).open();
    }

    extractSmilesFromMarkdown(content: string): string[] {
        const results: string[] = [];
        const blockRegex = /```smiles\n([\s\S]*?)\n```/g;
        let match: RegExpExecArray | null;
        while ((match = blockRegex.exec(content)) !== null) {
            if (match[1]) results.push(match[1].trim());
        }
        const inlineRegex = /\$smiles=([^\s`'"]+)/g;
        while ((match = inlineRegex.exec(content)) !== null) {
            if (match[1]) results.push(match[1].trim());
        }
        return results;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// --- MODALS ---

class MasterSearchModal extends Modal {
    plugin: ChemSearchPlugin;
    searchInput!: HTMLInputElement;

    constructor(app: App, plugin: ChemSearchPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Search for a Container / Compound" });
        
        const subtitle = contentEl.createEl("p", { text: "Search metadata (Name, Synonym, CAS, Barcode) or draw a substructure.", cls: "color-text-muted" });
        subtitle.style.fontSize = "0.9em";
        subtitle.style.marginBottom = "15px";

        const container = contentEl.createDiv();
        container.style.background = "var(--background-secondary)";
        container.style.padding = "20px";
        container.style.borderRadius = "8px";

        const label = container.createEl("label", { text: "Name, CAS Number, or Barcode:", cls: "color-text-normal" });
        label.style.display = "block";
        
        this.searchInput = container.createEl("input", { type: "text", placeholder: "e.g., Toluene, 108-88-3, or BC-1004" });
        this.searchInput.style.width = "100%";
        this.searchInput.style.marginBottom = "20px";
        this.searchInput.style.marginTop = "5px";

        const btnGrid = container.createDiv();
        btnGrid.style.display = "flex";
        btnGrid.style.gap = "10px";
        btnGrid.style.justifyContent = "space-between";
        btnGrid.style.alignItems = "center";

        const structureBtn = btnGrid.createEl("button", { text: "Structure Search ▾" });
        structureBtn.onclick = () => {
            const chemEdit = this.plugin.getChemEdit();
            if (!chemEdit) {
                new Notice("A Structure Drawing plugin is required for this feature.");
                return;
            }
            this.close();
            chemEdit.api.openEditor("", "smiles", async (querySmiles: string) => {
                await this.plugin.executeStructureSearchSafe(querySmiles, chemEdit);
            });
        };

        const metaSearchBtn = btnGrid.createEl("button", { text: "Search Inventory", cls: "mod-cta" });
        metaSearchBtn.onclick = () => {
            const query = this.searchInput.value.trim();
            if (query) {
                void this.plugin.performMetadataSearch(query);
                this.close();
            } else {
                new Notice("Enter a search term.");
            }
        };

        this.searchInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") metaSearchBtn.click();
        });

        const warning = container.createEl("div", { text: "(Note: Vault-wide structure searches may take a moment to process.)", cls: "color-text-muted" });
        warning.style.fontSize = "0.8em";
        warning.style.marginTop = "15px";

        window.setTimeout(() => this.searchInput.focus(), 50);
    }
    onClose() { this.contentEl.empty(); }
}

class MetadataSearchResultsModal extends Modal {
    query: string;
    results: TFile[];

    constructor(app: App, query: string, results: TFile[]) {
        super(app);
        this.query = query;
        this.results = results;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: `Inventory Results for: "${this.query}"` });
        
        if (this.results.length === 0) {
            contentEl.createEl("p", { text: "No matching containers or files found." });
            return;
        }

        const list = contentEl.createEl("ul");
        for (const file of this.results) {
            const li = list.createEl("li");
            li.style.cursor = "pointer";
            li.style.padding = "5px";
            li.style.color = "var(--text-accent)";
            li.createSpan({ text: file.basename });
            li.onclick = () => {
                void this.app.workspace.getLeaf(false).openFile(file);
                this.close();
            };
        }
    }
    onClose() { this.contentEl.empty(); }
}

class InventoryModal extends Modal {
    plugin: ChemSearchPlugin;
    nameInput!: HTMLInputElement;
    casInput!: HTMLInputElement;
    smilesInput!: HTMLInputElement;
    sizeInput!: HTMLInputElement;
    barcodeInput!: HTMLInputElement;
    locationInput!: HTMLInputElement;
    supplierInput!: HTMLInputElement;
    expiryInput!: HTMLInputElement;
    productCodeInput!: HTMLInputElement;
    
    mwFormulaText!: HTMLDivElement;
    safetyInfoText!: HTMLDivElement;

    calculatedMW = "";
    calculatedFormula = "";
    pubchemCid = "";

    constructor(app: App, plugin: ChemSearchPlugin) {
        super(app);
        this.plugin = plugin;
    }

    getUniqueFrontmatterValues(key: string): string[] {
        const files = this.app.vault.getMarkdownFiles();
        const values = new Set<string>();
        
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache && cache.frontmatter) {
                const val: unknown = cache.frontmatter[key];
                if (typeof val === 'string' && val.trim() !== '') {
                    values.add(val.trim());
                }
            }
        }
        return Array.from(values).sort();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Add a Container to Inventory" });
        this.modalEl.style.width = "70vw";

        const subtitle = contentEl.createEl("p", { text: "Physical inventory details (CAS, Supplier, Location) must be entered manually.", cls: "color-text-muted" });
        subtitle.style.fontSize = "0.9em";
        subtitle.style.marginBottom = "15px";

        const locations = this.getUniqueFrontmatterValues('location');
        const locationDatalist = contentEl.createEl('datalist');
        locationDatalist.id = 'inventory-locations';
        locations.forEach(loc => locationDatalist.createEl('option', { value: loc }));

        const suppliers = this.getUniqueFrontmatterValues('supplier');
        const supplierDatalist = contentEl.createEl('datalist');
        supplierDatalist.id = 'inventory-suppliers';
        suppliers.forEach(sup => supplierDatalist.createEl('option', { value: sup }));

        const grid = contentEl.createDiv();
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "1fr 1fr";
        grid.style.gap = "15px";
        grid.style.marginBottom = "15px";

        const createInput = (parent: HTMLElement, label: string, placeholder: string) => {
            const div = parent.createDiv();
            div.createEl("label", { text: label, cls: "color-text-muted" }).style.display = "block";
            const input = div.createEl("input", { type: "text", placeholder });
            input.style.width = "100%";
            return input;
        };

        this.nameInput = createInput(grid, "Container Name (*)", "e.g., Toluene");
        this.casInput = createInput(grid, "CAS Number", "e.g., 108-88-3");
        this.sizeInput = createInput(grid, "Container Size", "e.g., 500 mL or 100 g");
        this.barcodeInput = createInput(grid, "Barcode", "e.g., LAB-CHEM-001");
        
        this.locationInput = createInput(grid, "Location", "e.g., Fumehood Cupboard 2");
        this.locationInput.setAttribute('list', 'inventory-locations');
        
        this.supplierInput = createInput(grid, "Supplier", "e.g., Sigma-Aldrich");
        this.supplierInput.setAttribute('list', 'inventory-suppliers');
        
        this.expiryInput = createInput(grid, "Expiry Date", "e.g., 2028-06-14");
        this.productCodeInput = createInput(grid, "Product Code", "e.g., 244511");
        
        this.smilesInput = createInput(grid, "SMILES (For Structure Search)", "e.g., CC1=CC=CC=C1");
        this.smilesInput.parentElement!.style.gridColumn = "span 2";

        const actionGrid = contentEl.createDiv();
        actionGrid.style.display = "flex";
        actionGrid.style.gap = "10px";
        actionGrid.style.marginTop = "10px";
        actionGrid.style.marginBottom = "10px";

        const fetchOnlineBtn = actionGrid.createEl("button", { text: "1. Fetch Safety & SMILES (Online)" });
        fetchOnlineBtn.onclick = () => { void this.fetchSafetyOnline(); };

        const calcOfflineBtn = actionGrid.createEl("button", { text: "2. Calc Formula & MW from SMILES (Offline)" });
        calcOfflineBtn.onclick = () => this.calculateOffline();

        this.mwFormulaText = contentEl.createDiv();
        this.mwFormulaText.style.padding = "5px";
        
        this.safetyInfoText = contentEl.createDiv();
        this.safetyInfoText.style.padding = "5px";

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "flex-end";
        btnContainer.style.gap = "10px";
        btnContainer.style.marginTop = "20px";

        const saveBtn = btnContainer.createEl("button", { text: "Save Container", cls: "mod-cta" });
        saveBtn.onclick = () => { void this.saveToInventory(); };

        const closeBtn = btnContainer.createEl("button", { text: "Cancel" });
        closeBtn.onclick = () => this.close();
    }

    async fetchSafetyOnline() {
        const name = this.nameInput.value.trim();
        if (!name) {
            new Notice("Please enter a chemical name first.");
            return;
        }

        new Notice("Fetching data from online databases...");
        
        try {
            const pubchemRes = await requestUrl(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/property/CanonicalSMILES/JSON`);
            if (pubchemRes.status === 200) {
                interface PubChemProps { CanonicalSMILES?: string; CID?: number; }
                interface PubChemResponse { PropertyTable?: { Properties?: PubChemProps[] } }
                const data = pubchemRes.json as PubChemResponse;
                const props = data?.PropertyTable?.Properties?.[0];
                if (props?.CanonicalSMILES) this.smilesInput.value = props.CanonicalSMILES;
                if (props?.CID) this.pubchemCid = props.CID.toString();
            }
        } catch {
            // Silent fallback
        }

        if (!this.smilesInput.value) {
            try {
                const cactusRes = await requestUrl(`https://cactus.nci.nih.gov/chemical/structure/${encodeURIComponent(name)}/smiles`);
                if (cactusRes.status === 200) {
                    this.smilesInput.value = cactusRes.text.trim();
                }
            } catch {
                new Notice(`Could not automatically find a SMILES string for "${name}". You may need to paste one manually.`);
            }
        }

        if (this.pubchemCid || this.smilesInput.value) {
            this.safetyInfoText.empty();
            const sSpan = this.safetyInfoText.createSpan();
            sSpan.style.color = "var(--text-success)";
            sSpan.createEl("b", { text: "Fetched successfully! " });
            if (this.pubchemCid) {
                sSpan.createSpan({ text: `Found PubChem CID ${this.pubchemCid}. Risk assessment will be linked.` });
            }
            new Notice("Data fetched successfully!");
        }
    }

    calculateOffline() {
        const smiles = this.smilesInput.value.trim();
        if (!smiles) {
            new Notice("Please enter a SMILES string first.");
            return;
        }
        
        const props = this.plugin.getOfflineProperties(smiles);
        if (props) {
            this.calculatedFormula = props.formula;
            this.calculatedMW = props.mw.toFixed(2);
            
            this.mwFormulaText.empty();
            const mwSpan = this.mwFormulaText.createSpan();
            mwSpan.style.color = "var(--text-success)";
            mwSpan.createEl("b", { text: "Calculated Offline: " });
            mwSpan.createSpan({ text: `MW ${this.calculatedMW} g/mol | Formula ${this.calculatedFormula}` });
        } else {
            new Notice("Invalid SMILES. Could not calculate properties.");
        }
    }

    async saveToInventory() {
        const name = this.nameInput.value.trim();
        if (!name) {
            new Notice("Container Name is required.");
            return;
        }

        const folderPath = this.plugin.settings.inventoryFolder;
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) await this.app.vault.createFolder(folderPath);

        const safeName = name.replace(/[\\/:*?"<>|]/g, "_");
        const filePath = `${folderPath}/${safeName}.md`;

        let content = `---\n`;
        content += `name: "${name}"\n`;
        content += `tags: [inventory, chemical]\n`;
        if (this.casInput.value.trim()) content += `cas: "${this.casInput.value.trim()}"\n`;
        if (this.barcodeInput.value.trim()) content += `barcode: "${this.barcodeInput.value.trim()}"\n`;
        if (this.sizeInput.value.trim()) content += `container_size: "${this.sizeInput.value.trim()}"\n`;
        if (this.locationInput.value.trim()) content += `location: "${this.locationInput.value.trim()}"\n`;
        if (this.supplierInput.value.trim()) content += `supplier: "${this.supplierInput.value.trim()}"\n`;
        if (this.productCodeInput.value.trim()) content += `product_code: "${this.productCodeInput.value.trim()}"\n`;
        if (this.expiryInput.value.trim()) content += `expiry_date: "${this.expiryInput.value.trim()}"\n`;
        if (this.calculatedMW) content += `mw: ${this.calculatedMW}\n`;
        if (this.calculatedFormula) content += `formula: "${this.calculatedFormula}"\n`;
        content += `---\n\n`;

        content += `# ${name}\n\n`;
        
        const smiles = this.smilesInput.value.trim();
        if (smiles) {
            content += `## Structure\n`;
            content += `\`\`\`smiles\n${smiles}\n\`\`\`\n\n`;
        }

        content += `## Risk Assessment & Safety Data\n`;
        if (this.pubchemCid) {
            content += `> [!warning] **Hazards & SDS**\n`;
            content += `> Standard safety data can be found at the [PubChem Laboratory Chemical Safety Summary (LCSS)](https://pubchem.ncbi.nlm.nih.gov/compound/${this.pubchemCid}#datasheet=LCSS).\n\n`;
        }
        content += `- [ ] **Local Risk Assessment Completed**\n`;
        content += `- **Handling Notes:** \n`;
        content += `- **Waste Disposal:** \n`;

        try {
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                new Notice(`File ${safeName}.md already exists. Please rename or delete it first.`);
                return;
            }
            await this.app.vault.create(filePath, content);
            new Notice(`${name} added to inventory!`);
            this.close();
        } catch {
            new Notice("Error saving inventory file.");
        }
    }

    onClose() { this.contentEl.empty(); }
}

class SearchResultsModal extends Modal {
    querySmiles: string;
    results: { file: TFile, matchedSmiles: string[] }[];
    chemEdit: ChemEditPluginInstance | null;

    constructor(app: App, querySmiles: string, results: { file: TFile, matchedSmiles: string[] }[], chemEdit: ChemEditPluginInstance | null) {
        super(app);
        this.querySmiles = querySmiles;
        this.results = results;
        this.chemEdit = chemEdit;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.style.width = "80vw";
        this.modalEl.style.height = "80vh";

        contentEl.createEl("h2", { text: `Found ${this.results.length} files matching substructure` });

        const queryContainer = contentEl.createDiv();
        queryContainer.style.marginBottom = "20px";
        queryContainer.style.padding = "10px";
        queryContainer.style.background = "var(--background-secondary)";
        queryContainer.style.borderRadius = "8px";
        
        queryContainer.empty();
        queryContainer.createEl('strong', { text: 'Query Fragment:' });
        queryContainer.createEl('br');

        if (this.chemEdit && this.chemEdit.api) {
            const queryPreview = await this.chemEdit.api.renderStructure(this.querySmiles, 150, 150);
            if (queryPreview) queryContainer.appendChild(queryPreview);
        } else {
            queryContainer.createEl("code", { text: this.querySmiles, cls: "color-text-normal" });
        }

        const resultsContainer = contentEl.createDiv();
        resultsContainer.style.overflowY = "auto";
        resultsContainer.style.maxHeight = "calc(100% - 150px)";
        resultsContainer.style.display = "grid";
        resultsContainer.style.gridTemplateColumns = "repeat(auto-fill, minmax(250px, 1fr))";
        resultsContainer.style.gap = "15px";

        if (this.results.length === 0) {
            resultsContainer.createEl("p", { text: "No matching structures found in your vault." });
            return;
        }

        for (const result of this.results) {
            const card = resultsContainer.createDiv();
            card.style.border = "1px solid var(--background-modifier-border)";
            card.style.borderRadius = "8px";
            card.style.padding = "10px";
            card.style.background = "var(--background-primary)";
            card.style.cursor = "pointer";

            card.addEventListener('mouseenter', () => card.style.background = "var(--background-secondary-alt)");
            card.addEventListener('mouseleave', () => card.style.background = "var(--background-primary)");

            card.addEventListener("click", () => {
                void this.app.workspace.getLeaf(false).openFile(result.file);
                this.close();
            });

            const h4 = card.createEl("h4", { text: result.file.basename, cls: "color-text-normal" });
            h4.style.margin = "0 0 10px 0";
            
            const targetSmiles = result.matchedSmiles[0];
            if (!targetSmiles) continue;

            if (this.chemEdit && this.chemEdit.api) {
                const resultPreview = await this.chemEdit.api.renderStructure(targetSmiles, 200, 200);
                if (resultPreview) card.appendChild(resultPreview);
            } else {
                const textDiv = card.createDiv({ text: targetSmiles, cls: "color-text-muted" });
                textDiv.style.wordBreak = "break-all";
            }
        }
    }
    onClose() { this.contentEl.empty(); }
}

class ElectrolysisModal extends Modal {
    editor?: Editor;

    constructor(app: App, editor?: Editor) {
        super(app);
        this.editor = editor;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Electrolysis & Faradaic Efficiency" });

        const grid = contentEl.createDiv();
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "1fr 1fr";
        grid.style.gap = "10px";
        grid.style.marginBottom = "15px";

        const createInput = (parent: HTMLElement, label: string, placeholder: string) => {
            const div = parent.createDiv();
            div.createEl("label", { text: label }).style.display = "block";
            const input = div.createEl("input", { type: "number", placeholder });
            input.style.width = "100%";
            return input;
        };

        const inputMA = createInput(grid, "Constant Current (mA)", "2.5");
        const inputH = createInput(grid, "Time (hours)", "4.0");
        const inputN = createInput(grid, "Electrons transferred (n)", "2");
        const inputYield = createInput(grid, "Actual Yield (mmol) [Optional]", "0.15");

        const resultBox = contentEl.createDiv();
        resultBox.style.padding = "10px";
        resultBox.style.background = "var(--background-secondary)";
        resultBox.style.borderRadius = "8px";
        resultBox.style.marginBottom = "15px";
        resultBox.style.display = "none";

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "flex-end";
        btnContainer.style.gap = "10px";

        const calcBtn = btnContainer.createEl("button", { text: "Calculate", cls: "mod-cta" });
        const insertBtn = btnContainer.createEl("button", { text: "Insert into Note" });
        insertBtn.style.display = "none";

        let finalMarkdown = "";

        calcBtn.onclick = () => {
            const i_mA = parseFloat(inputMA.value) || 0;
            const t_h = parseFloat(inputH.value) || 0;
            const n = parseFloat(inputN.value) || 1;
            const yield_mmol = parseFloat(inputYield.value) || 0;

            const i_A = i_mA / 1000;
            const t_s = t_h * 3600;
            const q = i_A * t_s;
            const mol_e = q / 96485;
            const mmol_e = mol_e * 1000;
            const theoretical_mmol = mmol_e / n;

            resultBox.empty();
            resultBox.createEl('b', { text: 'Charge Passed (Q): ' });
            resultBox.createSpan({ text: `${q.toFixed(2)} C` });
            resultBox.createEl('br');
            resultBox.createEl('b', { text: 'Electrons (e-): ' });
            resultBox.createSpan({ text: `${mmol_e.toFixed(3)} mmol` });
            resultBox.createEl('br');
            resultBox.createEl('b', { text: 'Theoretical Yield: ' });
            resultBox.createSpan({ text: `${theoretical_mmol.toFixed(3)} mmol` });

            finalMarkdown = `**Electrolysis Parameters:**\n* Constant Current: ${i_mA} mA\n* Time: ${t_h} h\n* Charge Passed ($Q$): ${q.toFixed(2)} C (${mmol_e.toFixed(3)} mmol $e^-$)\n* Theoretical Yield ($n=${n}$): ${theoretical_mmol.toFixed(3)} mmol\n`;

            if (yield_mmol > 0) {
                const fe = (yield_mmol / theoretical_mmol) * 100;
                resultBox.createEl('br');
                resultBox.createEl('br');
                resultBox.createEl('b', { text: 'Faradaic Efficiency: ' });
                const feSpan = resultBox.createSpan({ text: `${fe.toFixed(1)}%` });
                feSpan.style.color = "var(--text-success)";
                feSpan.style.fontWeight = "bold";
                finalMarkdown += `* Faradaic Efficiency (FE): ${fe.toFixed(1)}%\n`;
            }

            resultBox.style.display = "block";
            
            if (this.editor) insertBtn.style.display = "block";
        };

        insertBtn.onclick = () => {
            if (this.editor) {
                const cursor = this.editor.getCursor();
                this.editor.replaceRange(finalMarkdown, cursor);
                new Notice("Electrolysis data inserted!");
                this.close();
            }
        };
    }
    onClose() { this.contentEl.empty(); }
}

class BoilerplateModal extends Modal {
    boilerplate: string;
    editor: Editor;

    constructor(app: App, boilerplate: string, editor: Editor) {
        super(app);
        this.boilerplate = boilerplate;
        this.editor = editor;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Experimental Section Boilerplate" });

        const infoBox = contentEl.createDiv();
        infoBox.style.padding = "15px";
        infoBox.style.background = "var(--background-secondary)";
        infoBox.style.borderRadius = "8px";
        infoBox.style.marginBottom = "15px";
        
        const textArea = infoBox.createEl("textarea");
        textArea.style.width = "100%";
        textArea.style.height = "250px";
        textArea.style.fontFamily = "monospace";
        textArea.value = this.boilerplate;

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "flex-end";
        btnContainer.style.gap = "10px";

        const pasteBtn = btnContainer.createEl("button", { text: "Insert into Note", cls: "mod-cta" });
        pasteBtn.onclick = () => {
            const cursor = this.editor.getCursor();
            this.editor.replaceRange(textArea.value, cursor);
            new Notice("Boilerplate inserted!");
            this.close();
        };

        const closeBtn = btnContainer.createEl("button", { text: "Cancel" });
        closeBtn.onclick = () => this.close();
    }
    onClose() { this.contentEl.empty(); }
}

class FormattedNoticeModal extends Modal {
    titleText: string;
    formula: string;
    mw: string;
    exact: string;

    constructor(app: App, titleText: string, formula: string, mw: string, exact: string) {
        super(app);
        this.titleText = titleText;
        this.formula = formula;
        this.mw = mw;
        this.exact = exact;
    }
    onOpen() {
        this.contentEl.createEl("h3", { text: this.titleText });
        const div = this.contentEl.createDiv();
        div.style.padding = "15px";
        div.style.background = "var(--background-secondary)";
        div.style.borderRadius = "8px";
        
        div.createEl('b', { text: 'Formula: ' });
        div.createSpan({ text: this.formula });
        div.createEl('br');
        div.createEl('b', { text: 'Molecular Weight: ' });
        div.createSpan({ text: `${this.mw} g/mol` });
        div.createEl('br');
        div.createEl('b', { text: 'Exact Mass (MS): ' });
        const exactSpan = div.createSpan({ text: this.exact });
        exactSpan.style.color = "var(--text-success)";
        exactSpan.style.fontWeight = "bold";
    }
    onClose() { this.contentEl.empty(); }
}

class EaResultsModal extends Modal {
    formula: string;
    mw: number;
    eaString: string;
    editor?: Editor;

    constructor(app: App, formula: string, mw: number, eaString: string, editor?: Editor) {
        super(app);
        this.formula = formula;
        this.mw = mw;
        this.eaString = eaString;
        this.editor = editor;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Elemental Analysis (Combustion)" });

        const infoBox = contentEl.createDiv();
        infoBox.style.padding = "15px";
        infoBox.style.background = "var(--background-secondary)";
        infoBox.style.borderRadius = "8px";
        infoBox.style.marginBottom = "15px";
        
        infoBox.createEl('b', { text: 'Formula: ' });
        infoBox.createSpan({ text: this.formula });
        infoBox.createEl('br');
        infoBox.createEl('b', { text: 'Molecular Weight: ' });
        infoBox.createSpan({ text: `${this.mw.toFixed(3)} g/mol` });
        infoBox.createEl('br');
        infoBox.createEl('br');
        infoBox.createEl('b', { text: 'Formatted String:' });
        infoBox.createEl('br');
        
        const codeBlock = infoBox.createEl('code', { text: this.eaString });
        codeBlock.style.display = "block";
        codeBlock.style.padding = "8px";
        codeBlock.style.marginTop = "5px";
        codeBlock.style.background = "var(--background-primary)";
        codeBlock.style.userSelect = "all";

        const btnContainer = contentEl.createDiv();
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "flex-end";
        btnContainer.style.gap = "10px";

        if (this.editor) {
            const pasteBtn = btnContainer.createEl("button", { text: "Insert into Note", cls: "mod-cta" });
            pasteBtn.onclick = () => {
                if (this.editor) {
                    const cursor = this.editor.getCursor();
                    this.editor.replaceRange(`${this.eaString}\n`, cursor);
                    new Notice("Elemental Analysis inserted!");
                }
                this.close();
            };
        }

        const closeBtn = btnContainer.createEl("button", { text: "Close" });
        closeBtn.onclick = () => this.close();
    }
    onClose() { this.contentEl.empty(); }
}

class ExternalDatabaseModal extends Modal {
    constructor(app: App) {
        super(app);
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Search External Databases" });
        contentEl.createEl("p", { text: "Enter a chemical name, CAS, or SMILES:", cls: "color-text-muted" });

        const input = contentEl.createEl("input", { type: "text" });
        input.style.width = "100%";
        input.style.marginBottom = "20px";

        const btnGrid = contentEl.createDiv();
        btnGrid.style.display = "grid";
        btnGrid.style.gridTemplateColumns = "1fr 1fr";
        btnGrid.style.gap = "10px";

        const createNavBtn = (text: string, urlGenerator: (val: string) => string) => {
            const btn = btnGrid.createEl("button", { text: text });
            btn.onclick = () => {
                const val = input.value.trim();
                if (val) window.open(urlGenerator(val), '_blank');
            };
        };

        createNavBtn("Google Scholar", (v) => `https://scholar.google.com/scholar?q=${encodeURIComponent(v)}`);
        createNavBtn("PubChem", (v) => `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(v)}`);
        createNavBtn("ChemSpider", (v) => `https://www.chemspider.com/Search.aspx?q=${encodeURIComponent(v)}`);
        createNavBtn("NIST WebBook", (v) => `https://webbook.nist.gov/cgi/cbook.cgi?Name=${encodeURIComponent(v)}&Units=SI`);

        const reaxysBtn = btnGrid.createEl("button", { text: "Open Reaxys Portal" });
        reaxysBtn.onclick = () => window.open('https://www.reaxys.com/', '_blank');

        const sdbsBtn = btnGrid.createEl("button", { text: "Open SDBS Portal" });
        sdbsBtn.onclick = () => window.open('https://sdbs.db.aist.go.jp/sdbs/cgi-bin/cre_index.cgi', '_blank');

        window.setTimeout(() => input.focus(), 50);
    }
    onClose() { this.contentEl.empty(); }
}

class TextInputModal extends Modal {
    onSubmit: (value: string) => void;
    titleText: string;

    constructor(app: App, titleText: string, onSubmit: (value: string) => void) {
        super(app);
        this.titleText = titleText;
        this.onSubmit = onSubmit;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.titleText });
        const input = contentEl.createEl("input", { type: "text" });
        input.style.width = "100%";
        input.style.marginBottom = "15px";

        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && input.value) {
                this.onSubmit(input.value.trim());
                this.close();
            }
        });

        const btn = contentEl.createEl("button", { text: "Submit", cls: "mod-cta" });
        btn.onclick = () => {
            if (input.value) {
                this.onSubmit(input.value.trim());
                this.close();
            }
        };
        window.setTimeout(() => input.focus(), 50);
    }
    onClose() { this.contentEl.empty(); }
}

// eslint-disable-next-line obsidianmd/no-missing-setting-definitions
class ChemSearchSettingTab extends PluginSettingTab {
    plugin: ChemSearchPlugin;

    constructor(app: App, plugin: ChemSearchPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
        
        new Setting(containerEl).setName('General').setHeading();

        new Setting(containerEl)
            .setName('Inventory Folder Path')
            .setDesc('Folder where new chemical inventory files will be saved.')
            .addText(text => text
                .setPlaceholder('Chemical_Inventory')
                .setValue(this.plugin.settings.inventoryFolder)
                .onChange(async (value) => {
                    this.plugin.settings.inventoryFolder = value.trim() || 'Chemical_Inventory';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('MS Decimal Precision')
            .setDesc('Number of decimal places for Exact Mass calculations.')
            .addText(text => text
                .setPlaceholder('4')
                .setValue(this.plugin.settings.msDecimals.toString())
                .onChange(async (value) => {
                    this.plugin.settings.msDecimals = parseInt(value) || 4;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Name-to-SMILES Paste Format')
            .setDesc('Use {SMILES} as a placeholder. Formats the string inserted into your notes.')
            .addTextArea(text => text
                .setValue(this.plugin.settings.smilesPasteFormat)
                .onChange(async (value) => {
                    this.plugin.settings.smilesPasteFormat = value;
                    await this.plugin.saveSettings();
                }));
    }
}