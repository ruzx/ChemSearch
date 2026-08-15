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
                const plugObj = plug as Record<string, unknown>;
                const api = plugObj.api;
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
            
            const fm = cache?.frontmatter;
            if (fm) {
                const name: unknown = fm['name'];
                if (typeof name === 'string' && name.toLowerCase().includes(lowerQuery)) matched = true;
                
                const cas: unknown = fm['cas'];
                if (typeof cas === 'string' && cas.toLowerCase().includes(lowerQuery)) matched = true;
                
                const barcode: unknown = fm['barcode'];
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
        contentEl.createEl("h3", { text: "Search Container / Compound" });
        contentEl.createEl("p", { text: "Search metadata (Name, Synonym, CAS, Barcode) or draw a substructure.", cls: "setting-item-description" });

        let query = "";
        let searchBtnCtrl: HTMLButtonElement | undefined;

        new Setting(contentEl)
            .setName("Name, CAS Number, or Barcode:")
            .addText(text => {
                text.setPlaceholder("e.g., Toluene, 108-88-3");
                text.onChange(val => query = val);
                text.inputEl.addEventListener("keypress", (e) => {
                    if (e.key === "Enter" && searchBtnCtrl) searchBtnCtrl.click();
                });
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(contentEl)
            .addButton(btn => {
                btn.setButtonText("Structure Search ▾");
                btn.onClick(() => {
                    const chemEdit = this.plugin.getChemEdit();
                    if (!chemEdit) {
                        new Notice("A Structure Drawing plugin is required for this feature.");
                        return;
                    }
                    this.close();
                    chemEdit.api.openEditor("", "smiles", async (querySmiles: string) => {
                        await this.plugin.executeStructureSearchSafe(querySmiles, chemEdit);
                    });
                });
            })
            .addButton(btn => {
                btn.setButtonText("Search Inventory");
                btn.setCta();
                searchBtnCtrl = btn.buttonEl;
                btn.onClick(() => {
                    const q = query.trim();
                    if (q) {
                        void this.plugin.performMetadataSearch(q);
                        this.close();
                    } else {
                        new Notice("Enter a search term.");
                    }
                });
            });

        contentEl.createEl("div", { text: "(Note: Vault-wide structure searches may take a moment to process.)", cls: "setting-item-description" });
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
            const li = list.createEl("li", { cls: "tree-item" });
            const inner = li.createEl("div", { cls: "tree-item-self is-clickable" });
            inner.createSpan({ text: file.basename, cls: "tree-item-inner" });
            
            inner.onclick = () => {
                const leaf = this.app.workspace.getLeaf();
                if (leaf) {
                    void leaf.openFile(file);
                }
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
            const fm = cache?.frontmatter;
            if (fm && key in fm) {
                const val: unknown = fm[key];
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
        contentEl.createEl("p", { text: "Physical inventory details (CAS, Supplier, Location) must be entered manually.", cls: "setting-item-description" });

        const locations = this.getUniqueFrontmatterValues('location');
        const locationDatalist = contentEl.createEl('datalist');
        locationDatalist.id = 'inventory-locations';
        locations.forEach(loc => locationDatalist.createEl('option', { value: loc }));

        const suppliers = this.getUniqueFrontmatterValues('supplier');
        const supplierDatalist = contentEl.createEl('datalist');
        supplierDatalist.id = 'inventory-suppliers';
        suppliers.forEach(sup => supplierDatalist.createEl('option', { value: sup }));

        const createInput = (name: string, placeholder: string, datalistId?: string) => {
            let input!: HTMLInputElement;
            new Setting(contentEl).setName(name).addText(t => {
                t.setPlaceholder(placeholder);
                if (datalistId) t.inputEl.setAttribute('list', datalistId);
                input = t.inputEl;
            });
            return input;
        };

        this.nameInput = createInput("Container Name (*)", "e.g., Toluene");
        this.casInput = createInput("CAS Number", "e.g., 108-88-3");
        this.sizeInput = createInput("Container Size", "e.g., 500 mL or 100 g");
        this.barcodeInput = createInput("Barcode", "e.g., LAB-CHEM-001");
        this.locationInput = createInput("Location", "e.g., Fumehood", 'inventory-locations');
        this.supplierInput = createInput("Supplier", "e.g., Sigma", 'inventory-suppliers');
        this.expiryInput = createInput("Expiry Date", "e.g., 2028-06-14");
        this.productCodeInput = createInput("Product Code", "e.g., 244511");
        this.smilesInput = createInput("SMILES (For Structure Search)", "e.g., CC1=CC=CC=C1");

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText("1. Fetch Safety & SMILES").onClick(() => { void this.fetchSafetyOnline(); }))
            .addButton(btn => btn.setButtonText("2. Calc Formula & MW").onClick(() => this.calculateOffline()));

        this.mwFormulaText = contentEl.createDiv({ cls: "setting-item-description" });
        this.safetyInfoText = contentEl.createDiv({ cls: "setting-item-description" });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
            .addButton(btn => btn.setButtonText("Save Container").setCta().onClick(() => { void this.saveToInventory(); }));
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
                const data = pubchemRes.json as Record<string, unknown>;
                const pTable = data?.PropertyTable as Record<string, unknown> | undefined;
                const pArr = pTable?.Properties as Array<Record<string, unknown>> | undefined;
                const props = pArr?.[0];
                
                if (props) {
                    if (typeof props.CanonicalSMILES === 'string') this.smilesInput.value = props.CanonicalSMILES;
                    if (typeof props.CID === 'number') this.pubchemCid = props.CID.toString();
                }
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

        contentEl.createEl("h2", { text: `Found ${this.results.length} files matching substructure` });

        const queryContainer = contentEl.createDiv();
        queryContainer.empty();
        queryContainer.createEl('strong', { text: 'Query Fragment:' });
        queryContainer.createEl('br');

        if (this.chemEdit && this.chemEdit.api) {
            const queryPreview = await this.chemEdit.api.renderStructure(this.querySmiles, 150, 150);
            if (queryPreview) queryContainer.insertAdjacentElement('beforeend', queryPreview);
        } else {
            queryContainer.createEl("code", { text: this.querySmiles, cls: "color-text-normal" });
        }

        const resultsContainer = contentEl.createDiv();

        if (this.results.length === 0) {
            resultsContainer.createEl("p", { text: "No matching structures found in your vault." });
            return;
        }

        for (const result of this.results) {
            const targetSmiles = result.matchedSmiles[0] || "";
            const s = new Setting(resultsContainer)
                .setName(result.file.basename)
                .setDesc(targetSmiles);
            
            s.settingEl.classList.add("is-clickable");
            s.settingEl.addEventListener("click", () => {
                const leaf = this.app.workspace.getLeaf();
                if (leaf) {
                    void leaf.openFile(result.file);
                }
                this.close();
            });

            if (this.chemEdit && this.chemEdit.api && targetSmiles) {
                const resultPreview = await this.chemEdit.api.renderStructure(targetSmiles, 80, 80);
                if (resultPreview) s.controlEl.insertAdjacentElement('beforeend', resultPreview);
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

        let inputMA!: HTMLInputElement, inputH!: HTMLInputElement, inputN!: HTMLInputElement, inputYield!: HTMLInputElement;

        new Setting(contentEl).setName("Constant Current (mA)").addText(t => { t.setValue("2.5"); inputMA = t.inputEl; });
        new Setting(contentEl).setName("Time (hours)").addText(t => { t.setValue("4.0"); inputH = t.inputEl; });
        new Setting(contentEl).setName("Electrons transferred (n)").addText(t => { t.setValue("2"); inputN = t.inputEl; });
        new Setting(contentEl).setName("Actual Yield (mmol) [Optional]").addText(t => { t.setValue("0.15"); inputYield = t.inputEl; });

        const resultBox = contentEl.createDiv({ cls: "setting-item-description" });
        let finalMarkdown = "";

        let insertBtnCtrl: HTMLButtonElement;

        new Setting(contentEl)
            .addButton(btn => {
                btn.setButtonText("Insert into Note");
                insertBtnCtrl = btn.buttonEl;
                insertBtnCtrl.addClass("is-hidden"); 
                btn.onClick(() => {
                    if (this.editor) {
                        const cursor = this.editor.getCursor();
                        this.editor.replaceRange(finalMarkdown, cursor);
                        new Notice("Electrolysis data inserted!");
                        this.close();
                    }
                });
            })
            .addButton(btn => {
                btn.setButtonText("Calculate");
                btn.setCta();
                btn.onClick(() => {
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
                        resultBox.createSpan({ text: `${fe.toFixed(1)}%` });
                        finalMarkdown += `* Faradaic Efficiency (FE): ${fe.toFixed(1)}%\n`;
                    }
                    
                    if (this.editor) insertBtnCtrl.removeClass("is-hidden");
                });
            });
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

        let textAreaVal = this.boilerplate;
        new Setting(contentEl).addTextArea(t => {
            t.setValue(this.boilerplate);
            t.onChange(v => textAreaVal = v);
            t.inputEl.rows = 15;
            t.inputEl.cols = 50;
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
            .addButton(btn => {
                btn.setButtonText("Insert into Note");
                btn.setCta();
                btn.onClick(() => {
                    const cursor = this.editor.getCursor();
                    this.editor.replaceRange(textAreaVal, cursor);
                    new Notice("Boilerplate inserted!");
                    this.close();
                });
            });
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
        const div = this.contentEl.createDiv({ cls: "setting-item-description" });
        
        div.createEl('b', { text: 'Formula: ' });
        div.createSpan({ text: this.formula });
        div.createEl('br');
        div.createEl('b', { text: 'Molecular Weight: ' });
        div.createSpan({ text: `${this.mw} g/mol` });
        div.createEl('br');
        div.createEl('b', { text: 'Exact Mass (MS): ' });
        div.createSpan({ text: this.exact });
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

        const infoBox = contentEl.createDiv({ cls: "setting-item-description" });
        
        infoBox.createEl('b', { text: 'Formula: ' });
        infoBox.createSpan({ text: this.formula });
        infoBox.createEl('br');
        infoBox.createEl('b', { text: 'Molecular Weight: ' });
        infoBox.createSpan({ text: `${this.mw.toFixed(3)} g/mol` });
        infoBox.createEl('br');
        infoBox.createEl('br');
        infoBox.createEl('b', { text: 'Formatted String:' });
        infoBox.createEl('br');
        
        infoBox.createEl('code', { text: this.eaString });

        const s = new Setting(contentEl);
        s.addButton(btn => btn.setButtonText("Close").onClick(() => this.close()));

        if (this.editor) {
            s.addButton(btn => {
                btn.setButtonText("Insert into Note");
                btn.setCta();
                btn.onClick(() => {
                    if (this.editor) {
                        const cursor = this.editor.getCursor();
                        this.editor.replaceRange(`${this.eaString}\n`, cursor);
                        new Notice("Elemental Analysis inserted!");
                    }
                    this.close();
                });
            });
        }
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
        
        let inputVal = "";
        new Setting(contentEl)
            .setName("Chemical name, CAS, or SMILES:")
            .addText(t => {
                t.onChange(v => inputVal = v);
                window.setTimeout(() => t.inputEl.focus(), 50);
            });

        const createNavBtn = (text: string, urlGenerator: (val: string) => string) => {
            new Setting(contentEl).setName(text).addButton(btn => {
                btn.setButtonText("Open");
                btn.onClick(() => {
                    const val = inputVal.trim();
                    if (val) window.open(urlGenerator(val), '_blank');
                });
            });
        };

        createNavBtn("Google Scholar", (v) => `https://scholar.google.com/scholar?q=${encodeURIComponent(v)}`);
        createNavBtn("PubChem", (v) => `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(v)}`);
        createNavBtn("ChemSpider", (v) => `https://www.chemspider.com/Search.aspx?q=${encodeURIComponent(v)}`);
        createNavBtn("NIST WebBook", (v) => `https://webbook.nist.gov/cgi/cbook.cgi?Name=${encodeURIComponent(v)}&Units=SI`);

        new Setting(contentEl).setName("Reaxys Portal").addButton(btn => btn.setButtonText("Open").onClick(() => window.open('https://www.reaxys.com/', '_blank')));
        new Setting(contentEl).setName("SDBS Portal").addButton(btn => btn.setButtonText("Open").onClick(() => window.open('https://sdbs.db.aist.go.jp/sdbs/cgi-bin/cre_index.cgi', '_blank')));
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
        
        let val = "";
        let submitBtnCtrl: HTMLButtonElement | undefined;

        new Setting(contentEl).addText(t => {
            t.onChange(v => val = v);
            t.inputEl.addEventListener("keypress", (e) => {
                if (e.key === "Enter" && submitBtnCtrl) submitBtnCtrl.click();
            });
            window.setTimeout(() => t.inputEl.focus(), 50);
        });

        new Setting(contentEl).addButton(btn => {
            btn.setButtonText("Submit");
            btn.setCta();
            submitBtnCtrl = btn.buttonEl;
            btn.onClick(() => {
                if (val) {
                    this.onSubmit(val.trim());
                    this.close();
                }
            });
        });
    }
    onClose() { this.contentEl.empty(); }
}

class ChemSearchSettingTab extends PluginSettingTab {
    plugin: ChemSearchPlugin;

    constructor(app: App, plugin: ChemSearchPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions() {
        return {};
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

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