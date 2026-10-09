# Synthetic PubChem mirror (same schema the worker reads), then the worker's own lookup.
import importlib.util, os, sqlite3, sys
mirror, worker = sys.argv[1], sys.argv[2]
path = os.path.join(mirror, "pubchem.sqlite")
if os.path.exists(path): os.remove(path)
db = sqlite3.connect(path)
db.executescript("""
CREATE TABLE synonym(name TEXT, cid INTEGER); CREATE TABLE smiles(cid INTEGER, smiles TEXT);
CREATE TABLE formula(cid INTEGER, formula TEXT); CREATE TABLE inchikey(key TEXT, cid INTEGER); CREATE TABLE iupac(cid INTEGER, name TEXT);
INSERT INTO synonym VALUES ('4-nitrophenol', 980), ('N,N''-dicyclohexylcarbodiimide', 10868), ('2''-deoxyadenosine', 13730), ('2-methylpropan-2-ol', 6386);
INSERT INTO smiles VALUES (980, 'O=[N+]([O-])c1ccc(O)cc1'), (10868, 'C1CCC(CC1)N=C=NC2CCCCC2'), (13730, 'Nc1ncnc2c1ncn2[C@H]1C[C@H](O)[C@@H](CO)O1'), (6386, 'CC(C)(C)O');
""")
db.commit(); db.close()
spec = importlib.util.spec_from_file_location("reactions_worker", worker)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
names = ["4-nitrophenol", "4‑nitrophenol", "4‐nitrophenol", "N,N'-dicyclohexylcarbodiimide", "N,N′-dicyclohexylcarbodiimide", "N,N’-dicyclohexylcarbodiimide", "2'-deoxyadenosine", "2′-deoxyadenosine", "2−methylpropan−2−ol"]
hits = mod._pubchem_mirror(mirror, names, [])["names"]
for name in names:
    print(f"{name!a:45} {'HIT' if name in hits else 'miss -> network PubChem'}")
