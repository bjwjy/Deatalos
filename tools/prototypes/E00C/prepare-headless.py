"""Create a research minimal runtime, not a product installer."""
import hashlib,json,pathlib,shutil
ROOT=pathlib.Path(__file__).resolve().parents[3]
CACHE=ROOT/'artifacts/tool-cache/E00C'
SOURCE=CACHE/'runtime/Hopsan-2.24.4-win64'
TARGET=CACHE/'headless'
FILES=['bin/hopsancore.dll','bin/libgcc_s_seh-1.dll','bin/libstdc++-6.dll','bin/libwinpthread-1.dll',
       'componentLibraries/defaultLibrary/defaultcomponentlibrary.dll','componentLibraries/defaultLibrary/LICENSE']
records=[]
for file in FILES:
    src,dst=SOURCE/file,TARGET/file;dst.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(src,dst)
    records.append(dict(path=file,size=src.stat().st_size,sha256=hashlib.sha256(src.read_bytes()).hexdigest()))
src=CACHE/'source/hopsan-2.24.4/HopsanCore/LICENSE';dst=TARGET/'licenses/HopsanCore-LICENSE.txt'
dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
(CACHE/'headless-manifest.json').write_text(json.dumps({'files':records,'binary_bytes':sum(r['size'] for r in records if r['path'].endswith('.dll')),'purpose':'research only; distribution compliance not closed'},indent=2)+'\n',encoding='utf-8')
