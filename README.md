# 🔍 ChemSearch

**Vault-wide chemical substructure search and inventory management for Obsidian.**
Perform vault-wide substructure searches, track physical container stock.

---

## ✨ Features

### 1. 🧬 Substructure & Inventory Search
- **Substructure Search:** Draw a chemical fragment in Ketcher and search your entire Obsidian vault for any Markdown files containing matching SMILES strings.
- **Search Portal:** Quickly search your vault's metadata (Name, Synonym, CAS, Barcode) to locate physical containers in your inventory.

### 2. 🧪 Chemical Inventory Manager
Add physical containers to your local database without relying on external web portals:
- **Safety Data Linking:** Automatically fetches safety data and PubChem CIDs to generate Laboratory Chemical Safety Summary (LCSS) links.
- **Smart Auto-Complete:** Dynamically scans existing inventory files to offer dropdown suggestions for previous **Locations** and **Suppliers**.
- **Dataview & Bases Ready:** Saves containers as native Markdown files tagged with `#inventory` and populated with structured YAML metadata (CAS, Barcode, Location, Supplier, Expiry).
- **Offline Calculations:** Computes Molecular Weight and Exact Formula offline directly from SMILES.

### 3. ⚡ Offline Tools
Run essential calculations instantly without an internet connection using the built-in offline atomic weight engine:
- **Exact Mass (MS) Calculator:** Generates precise monoisotopic masses for mass spectrometry.
- **Elemental Analysis (%CHNOS):** Formats combustion analysis text (e.g., `Calcd for C7H8: C, 91.25; H, 8.75. Found: [  ]`).
- **Experimental Boilerplate:** Generates standard ACS-style experimental sections.
- **Electrolysis Calculator:** Calculates Charge Passed ($Q$), theoretical yields, and Faradaic Efficiency (FE) for electrochemistry experiments.

---

## 📋 Requirements

To use the structural drawing features (Substructure Search), you must install one of the compatible chemical drawing plugins:
- **[ChemEdit](https://github.com/Acylation/obsidian-chemedit)** (Desktop optimized)
- **[ChemEdit Universal](https://github.com/Acylation/obsidian-chemedit-universal)** (Desktop & Mobile compatible)

*If a drawing plugin is not installed, ChemSearch will fall back to accepting manual SMILES string inputs.*

---

## 📊 Example: Dataview Integration

Because ChemSearch saves your inventory with structured YAML and the `#inventory` tag, you can build powerful dashboards using the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) plugin.

**View your entire inventory:**
```dataview
TABLE cas AS "CAS No.", supplier AS "Supplier", container_size AS "Size", mw AS "MW"
FROM #inventory
SORT name ASC

```

**Track expiring reagents:**

```dataview
TABLE expiry_date AS "Expiry", location AS "Location"
FROM #inventory
WHERE expiry_date != null
SORT expiry_date ASC

```

---

## 📥 Installation

**Manual Installation:**

1. Download the latest `main.js`, `manifest.json`, and `styles.css` (if applicable) from the [Releases page](https://www.google.com/search?q=https://github.com/Acylation/ChemSearch/releases).
2. Create a folder named `chemsearch` inside your vault's `.obsidian/plugins/` directory.
3. Place the downloaded files into that folder.
4. Reload Obsidian and enable **ChemSearch** in your Community Plugins settings.

---

## 🏆 Acknowledgements

* [OpenChemLib](https://www.google.com/search?q=https://github.com/cheminfo/openchemlib) for offline molecular parsing and substructure search algorithms.
* [PubChem PUG REST](https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest) and [NIH CACTUS](https://cactus.nci.nih.gov/) for web chemical identifier resolution.

---

## 🔬 Related Chemistry Plugins

ChemSearch focuses on **substructure searching, inventory management, and offline chemoinformatics**. Depending on your workflow, you may also find these Obsidian plugins useful:

| Plugin | Description |
| --- | --- |
| [ChemEdit](https://github.com/Acylation/obsidian-chemedit) | Native chemical structure editor and viewer powered by Ketcher and SmilesDrawer. |
| [ChemEdit Universal](https://github.com/Acylation/obsidian-chemedit-universal) | Cross-platform (Desktop & Mobile) chemical structure editor. |
| [Chem](https://github.com/Acylation/obsidian-chem) | Render **SMILES** structures locally using SmilesDrawer and RDKit.js. |
| [LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite) | Makes writing chemistry equations easier with LaTeX packages such as `mhchem` and `chemfig`. |
| [TikZJax](https://github.com/artisticat1/obsidian-tikzjax) | Render TikZ diagrams directly inside Obsidian, including figures created with `chemfig`. |

---

## 📄 License

MIT License.