#!/usr/bin/env python3
"""
=============================================================================
   Dead by Daylight MEGA SCRAPER
   All-in-one data and asset scraper
=============================================================================

This unified script combines all scraping functionality:
1. DATA SCRAPING - Fetches character, perk, and map data from dbd.tricky.lol API
2. IMAGE SCRAPING - Downloads portraits, perks, and map images from wiki.gg

Dependencies:
- requests (pip install requests)
- curl_cffi (pip install curl_cffi) - Required for bypassing Cloudflare on wiki.gg

Usage:
  python dbd_mega_scraper.py              # Run everything
  python dbd_mega_scraper.py --data-only  # Only scrape JSON data
  python dbd_mega_scraper.py --images-only # Only download images
  python dbd_mega_scraper.py --help       # Show help
"""

import os
import sys
import json
import time
import uuid
import re
import argparse
from urllib.parse import unquote

# Standard requests for API data
import requests as std_requests

# curl_cffi for bypassing Cloudflare (wiki.gg protection)
try:
    from curl_cffi import requests as cf_requests
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False
    print("[!] Warning: curl_cffi not installed. Image scraping will be disabled.")
    print("    Install with: pip install curl_cffi")

# =============================================================================
# CONFIGURATION
# =============================================================================

# API Endpoints
DATA_API_BASE = "https://dbd.tricky.lol/api"
DATA_CDN_BASE = "https://dbd.tricky.lol"
WIKI_BASE_URL = "https://deadbydaylight.wiki.gg"
WIKI_API_URL = f"{WIKI_BASE_URL}/api.php"

# Output directories
DATA_OUTPUT_FILE = "dbd_data.json"
IMAGES_OUTPUT_DIR = "dbd_images"

# Rate limiting
REQUEST_DELAY = 0.3  # seconds between wiki requests
API_TIMEOUT = 10     # seconds for API requests

# Headers
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

# Wiki categories
PORTRAIT_CATEGORY = "Category:Character Selection Icons"
PERK_CATEGORY = "Category:Perk images"

# =============================================================================
# SHARED UTILITIES
# =============================================================================

class Stats:
    """Simple stats tracker."""
    def __init__(self):
        self.reset()
    
    def reset(self):
        self.downloaded = 0
        self.skipped = 0
        self.errors = 0
        self.processed = 0

stats = Stats()

# ID to Name lookup for perk ownership resolution
ID_TO_NAME = {}

def register_identifier(identifier, name):
    """Store different representations of an identifier for reliable lookups."""
    if identifier is None:
        return
    ID_TO_NAME[identifier] = name
    str_id = str(identifier)
    ID_TO_NAME[str_id] = name
    if str_id.isdigit():
        ID_TO_NAME[int(str_id)] = name

def clean_description(text):
    """Convert HTML in perk text to readable plain text (mirrors the Node stripHtml cleaner)."""
    if not text:
        return ""
    text = re.sub(r'<br\s*/?>\s*', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<li[^>]*>', '\n- ', text, flags=re.IGNORECASE)
    text = re.sub(r'</li>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = text.replace('\xa0', ' ').replace('\ufffd', '')
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def apply_tunables(text, tunables):
    """Replace placeholder tokens like {0}, {1} with tier values."""
    if not text or not tunables:
        return text or ""
    iterable = tunables.items() if isinstance(tunables, dict) else enumerate(tunables)
    for key, tier in iterable:
        token = f"{{{key}}}"
        if isinstance(tier, (list, tuple)):
            value = "/".join(str(v) for v in tier)
        else:
            value = str(tier)
        text = text.replace(token, value)
    return text

def extract_real_name(story_text):
    """Best-effort extraction of a proper name from the start of a story/bio."""
    if not story_text:
        return None
    story_text = re.sub(r'<br\s*/?>', ' ', story_text, flags=re.IGNORECASE)
    chunk = story_text.split('.')[0]
    match = re.match(r"([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,2})", chunk.strip())
    if match:
        candidate = match.group(1).strip()
        if len(candidate.split()) >= 2:
            return candidate
    return None

def fix_image_url(path):
    """Convert relative paths to full CDN URLs."""
    if not path:
        return None
    if path.startswith('/'):
        return f"{DATA_CDN_BASE}{path}"
    return path

# =============================================================================
# DATA SCRAPING (from dbd.tricky.lol API)
# =============================================================================

def fetch_api_data(endpoint):
    """Fetch data from the DBD API. Raises on failure -- callers must not write partial data."""
    url = f"{DATA_API_BASE}/{endpoint}"
    print(f"    Fetching {url}...")
    try:
        response = std_requests.get(url, headers=HEADERS, timeout=API_TIMEOUT)
        response.raise_for_status()
        payload = response.json()
    except Exception as e:
        raise RuntimeError(f"fetch_api_data: {endpoint} failed: {e}")
    if not payload:
        raise RuntimeError(f"fetch_api_data: {endpoint} returned empty payload (aborting, refusing to write partial data)")
    return payload

def process_characters():
    """Fetches all characters and separates them into Killers and Survivors."""
    print("\n[*] Processing Characters...")
    raw_data = fetch_api_data("characters")
    
    killers = []
    survivors = []
    
    if not raw_data:
        print("    Endpoint 'characters' failed. Trying fallback endpoints...")
        killers_data = fetch_api_data("killer")
        survivors_data = fetch_api_data("survivor")
        raw_data = {}
        if isinstance(killers_data, dict):
            raw_data.update(killers_data)
        if isinstance(survivors_data, dict):
            raw_data.update(survivors_data)
    
    items = raw_data.values() if isinstance(raw_data, dict) else raw_data
    
    for key_id, char in (raw_data.items() if isinstance(raw_data, dict) else enumerate(items)):
        try:
            if not isinstance(char, dict) or not char.get('name'):
                continue
            
            name = char.get('name')
            role = char.get('role')
            internal_id = char.get('id', key_id)
            
            register_identifier(internal_id, name)
            register_identifier(key_id, name)
            
            image_url = fix_image_url(char.get('image'))
            story_text = char.get('story', '')
            
            if role == 'killer':
                real_name = char.get('real_name') or extract_real_name(story_text) or name
                killers.append({
                    "id": str(uuid.uuid4()),
                    "name": name,
                    "realName": real_name,
                    "power": char.get('power', 'Unknown Power'),
                    "difficulty": char.get('difficulty', 'Hard'),
                    "image": image_url,
                    "lore": clean_description(char.get('lore', 'The Fog obscures this knowledge...'))
                })
            elif role == 'survivor':
                survivors.append({
                    "id": str(uuid.uuid4()),
                    "name": name,
                    "role": "Survivor",
                    "difficulty": char.get('difficulty', 'Easy'),
                    "image": image_url
                })
        except Exception as e:
            print(f"    [!] Error processing character: {e}")
            continue
    
    print(f"    ✓ {len(killers)} killers, {len(survivors)} survivors")
    return killers, survivors

def process_perks():
    """Fetch and process all perks."""
    print("\n[*] Processing Perks...")
    raw_data = fetch_api_data("perks")
    perks = []
    
    items = raw_data.values() if isinstance(raw_data, dict) else raw_data
    
    for p in items:
        try:
            if not isinstance(p, dict) or not p.get('name'):
                continue
            
            name = p.get('name')
            raw_desc = p.get('description', '')
            desc = clean_description(apply_tunables(raw_desc, p.get('tunables')))
            
            owner_id = p.get('owner') or p.get('character')
            role = p.get('role', 'survivor').capitalize()
            
            owner_name = "General"
            if owner_id is not None:
                if owner_id in ID_TO_NAME:
                    owner_name = ID_TO_NAME[owner_id]
                elif isinstance(owner_id, str) and not owner_id.isdigit():
                    owner_name = owner_id
                else:
                    owner_name = f"All {role}s"
            else:
                owner_name = f"All {role}s"
            
            perks.append({
                "id": str(uuid.uuid4()),
                "name": name,
                "owner": owner_name,
                "type": role,
                "description": desc,
                "image": fix_image_url(p.get('image'))
            })
        except Exception:
            continue
    
    print(f"    ✓ {len(perks)} perks")
    return perks

def process_maps():
    """Fetch and process all maps."""
    print("\n[*] Processing Maps...")
    raw_data = fetch_api_data("maps")
    maps = []
    
    items = raw_data.values() if isinstance(raw_data, dict) else raw_data
    
    for m in items:
        try:
            if not isinstance(m, dict) or not m.get('name'):
                continue
            maps.append({
                "id": str(uuid.uuid4()),
                "name": m.get('name'),
                "realm": m.get('realm', 'Unknown Realm'),
                "description": clean_description(m.get('description', '')),
                "dlc": m.get('dlc'),
                "image": fix_image_url(m.get('image'))
            })
        except Exception:
            continue
    
    # Build realm index
    realms = {}
    for mp in maps:
        realm_name = mp.get('realm', 'Unknown Realm')
        if realm_name not in realms:
            realms[realm_name] = {
                "id": str(uuid.uuid4()),
                "name": realm_name,
                "image": mp.get('image'),
                "maps": []
            }
        realms[realm_name]["maps"].append(mp["id"])
    
    print(f"    ✓ {len(maps)} maps, {len(realms)} realms")
    return maps, list(realms.values())

def process_items():
    """Fetch and process all items (survivor items like flashlights, medkits, etc.)."""
    print("\n[*] Processing Items...")
    raw_data = fetch_api_data("items")
    items_list = []
    
    items = raw_data.values() if isinstance(raw_data, dict) else raw_data
    
    for key_id, item in (raw_data.items() if isinstance(raw_data, dict) else enumerate(items)):
        try:
            if not isinstance(item, dict) or not item.get('name'):
                continue
            
            items_list.append({
                "id": str(uuid.uuid4()),
                "internalId": key_id if isinstance(key_id, str) else None,
                "name": item.get('name'),
                "type": item.get('type', 'item'),
                "itemType": item.get('item_type'),
                "description": clean_description(apply_tunables(item.get('description', ''), item.get('modifiers'))),
                "role": item.get('role', 'survivor'),
                "rarity": item.get('rarity', 'common'),
                "bloodweb": item.get('bloodweb', 1) == 1,
                "event": item.get('event'),
                "image": fix_image_url(item.get('image'))
            })
        except Exception as e:
            print(f"    [!] Error processing item {key_id}: {e}")
            continue
    
    print(f"    ✓ {len(items_list)} items")
    return items_list

def process_offerings():
    """Fetch and process all offerings."""
    print("\n[*] Processing Offerings...")
    raw_data = fetch_api_data("offerings")
    offerings_list = []
    
    items = raw_data.values() if isinstance(raw_data, dict) else raw_data
    
    for key_id, offering in (raw_data.items() if isinstance(raw_data, dict) else enumerate(items)):
        try:
            if not isinstance(offering, dict) or not offering.get('name'):
                continue
            
            # Skip retired offerings if desired (keeping them but flagging)
            is_retired = offering.get('retired', 0) == 1
            
            # Check if offering is secret (indicated by "Secret" in description)
            raw_description = offering.get('description', '')
            is_secret = 'Secret' in raw_description or 'secret' in raw_description.lower().split('.')
            
            offerings_list.append({
                "id": str(uuid.uuid4()),
                "internalId": key_id if isinstance(key_id, str) else None,
                "name": offering.get('name'),
                "type": offering.get('type', 'offering'),
                "tags": offering.get('tags', []),
                "description": clean_description(raw_description),
                "role": offering.get('role'),  # Can be None for universal offerings
                "rarity": offering.get('rarity', 'common'),
                "retired": is_retired,
                "secret": is_secret,  # New field for secret offerings
                "image": fix_image_url(offering.get('image'))
            })
        except Exception as e:
            print(f"    [!] Error processing offering {key_id}: {e}")
            continue
    
    # Count secret offerings
    secret_count = sum(1 for o in offerings_list if o.get('secret'))
    print(f"    ✓ {len(offerings_list)} offerings ({secret_count} secret)")
    return offerings_list

def process_addons():
    """Fetch and process all addons (for items and killer powers)."""
    print("\n[*] Processing Addons...")
    raw_data = fetch_api_data("addons")
    addons_list = []
    
    # Complete mapping of power parent IDs to killer names
    # This allows us to assign killerName directly to each addon
    POWER_TO_KILLER = {
        "Item_Slasher_Beartrap": "The Trapper",
        "Item_Slasher_CloakBell": "The Wraith",
        "Item_Slasher_Chainsaw": "The Hillbilly",
        "Item_Slasher_Blinker": "The Nurse",
        "Item_Slasher_PhantomTrap": "The Hag",
        "Item_Slasher_Stalker": "The Shape",
        "Item_Slasher_Killer07Item": "The Doctor",
        "Item_Slasher_Hatchet": "The Huntress",
        "Item_Slasher_LFChainsaw": "The Cannibal",
        "Item_Slasher_DreamInducer": "The Nightmare",
        "Item_Slasher_ReverseBearTrap": "The Pig",
        "Item_Slasher_GasBomb": "The Clown",
        "Item_Slasher_PhaseWalker": "The Spirit",
        "Item_Slasher_Frenzy": "The Legion",
        "Item_Slasher_PlaguePower": "The Plague",
        "Item_Slasher_GhostPower": "The Ghost Face",
        "Item_Slasher_QatarKillerPower": "The Demogorgon",
        "Item_Slasher_Kanobo": "The Oni",
        "Item_Slasher_HarpoonRifle": "The Deathslinger",
        "Item_Slasher_TormentMode": "The Executioner",
        "Item_Slasher_K21Power": "The Blight",
        "Item_Slasher_K22Power": "The Twins",
        "Item_Slasher_ThrowingKnives": "The Trickster",
        "Item_Slasher_K24Power": "The Nemesis",
        "Item_Slasher_K25Power": "The Cenobite",
        "Item_Slasher_K26Power": "The Artist",
        "Item_Slasher_K27Power": "The Onryō",
        "Item_Slasher_K28Power": "The Dredge",
        "Item_Slasher_K29Power": "The Mastermind",
        "Item_Slasher_K30Power": "The Knight",
        "Item_Slasher_K31Power": "The Skull Merchant",
        "Item_Slasher_K32Power": "The Singularity",
        "Item_Slasher_K33Power": "The Xenomorph",
        "Item_Slasher_K34Power": "The Good Guy",
        "Item_Slasher_K35Power": "The Unknown",
        "Item_Slasher_K36Power": "The Lich",
        "Item_Slasher_K37Power": "The Dark Lord",
        "Item_Slasher_K38Power": "The Houndmaster",
        "Item_Slasher_K39Power": "The Ghoul",
        "Item_Slasher_K40Power": "The Animatronic",
        "Item_Slasher_K41Power": "The Krasue",
        "Item_Slasher_K42Power": "The First",
        "Item_K43Power": "The Slasher",
        "Item_K44Power": "The Judgment",
    }
    
    items = raw_data.values() if isinstance(raw_data, dict) else raw_data
    
    for key_id, addon in (raw_data.items() if isinstance(raw_data, dict) else enumerate(items)):
        try:
            if not isinstance(addon, dict) or not addon.get('name'):
                continue
            
            # Determine killerName for killer addons based on parents
            killer_name = None
            parents = addon.get('parents', [])
            if addon.get('role') == 'killer' and parents:
                for parent in parents:
                    if parent in POWER_TO_KILLER:
                        killer_name = POWER_TO_KILLER[parent]
                        break
            
            addons_list.append({
                "id": str(uuid.uuid4()),
                "internalId": key_id if isinstance(key_id, str) else None,
                "name": addon.get('name'),
                "type": addon.get('type', 'addon'),
                "itemType": addon.get('item_type'),
                "parents": parents,
                "killerName": killer_name,  # Direct killer assignment for killer addons
                "description": clean_description(apply_tunables(addon.get('description', ''), addon.get('modifiers'))),
                "role": addon.get('role', 'survivor'),
                "rarity": addon.get('rarity', 'common'),
                "bloodweb": addon.get('bloodweb', 1) == 1,
                "image": fix_image_url(addon.get('image'))
            })
        except Exception as e:
            print(f"    [!] Error processing addon {key_id}: {e}")
            continue
    
    # Count killer addons by killer for verification
    killer_counts = {}
    for addon in addons_list:
        if addon.get('killerName'):
            killer_counts[addon['killerName']] = killer_counts.get(addon['killerName'], 0) + 1
    
    print(f"    ✓ {len(addons_list)} addons total")
    print(f"    ✓ Killer addon counts: {len(killer_counts)} killers")
    for name, count in sorted(killer_counts.items()):
        if count != 20:
            print(f"      [!] {name}: {count} addons (expected 20)")
    
    return addons_list


def scrape_data():
    """Main data scraping function."""
    print("\n" + "=" * 60)
    print("   DATA SCRAPING (from dbd.tricky.lol API)")
    print("=" * 60)
    
    killers, survivors = process_characters()
    perks = process_perks()
    maps, realms = process_maps()
    items = process_items()
    offerings = process_offerings()
    addons = process_addons()
    
    data = {
        "killers": killers,
        "survivors": survivors,
        "perks": perks,
        "maps": maps,
        "realms": realms,
        "items": items,
        "offerings": offerings,
        "addons": addons
    }
    
    for category, entries in data.items():
        if not entries:
            raise RuntimeError(f"scrape_data: '{category}' came back empty (aborting, refusing to write partial data)")

    tmp_output_file = DATA_OUTPUT_FILE + ".tmp"
    with open(tmp_output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp_output_file, DATA_OUTPUT_FILE)
    
    print(f"\n[✓] Data saved to '{DATA_OUTPUT_FILE}'")
    print(f"    Stats: {len(killers)} Killers, {len(survivors)} Survivors, {len(perks)} Perks, {len(maps)} Maps, {len(realms)} Realms")
    print(f"           {len(items)} Items, {len(offerings)} Offerings, {len(addons)} Addons")
    
    return data

# =============================================================================
# IMAGE SCRAPING (from wiki.gg)
# =============================================================================

def setup_image_directories():
    """Create output directories for images."""
    print(f"\n[*] Setting up directory structure in '{IMAGES_OUTPUT_DIR}'...")
    
    subfolders = ["killers", "survivors", "perks", "maps", "items", "offerings", "addons"]
    
    if not os.path.exists(IMAGES_OUTPUT_DIR):
        os.makedirs(IMAGES_OUTPUT_DIR)
    
    for subfolder in subfolders:
        path = os.path.join(IMAGES_OUTPUT_DIR, subfolder)
        if not os.path.exists(path):
            os.makedirs(path)
            print(f"    → Created '{subfolder}' directory")
    
    print("[*] Directories ready.")

def wiki_api_request(params, max_retries=3):
    """Make a wiki API request with retry logic."""
    for attempt in range(max_retries):
        try:
            time.sleep(REQUEST_DELAY)
            response = cf_requests.get(WIKI_API_URL, params=params, impersonate='chrome')
            
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 429:
                wait_time = (attempt + 1) * 5
                print(f"    [!] Rate limited. Waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"    [!] API error: {response.status_code}")
                return None
        except Exception as e:
            print(f"    [!] Request error: {e}")
            if attempt < max_retries - 1:
                time.sleep(2)
    return None

def get_category_files(category_name):
    """Fetch all files from a MediaWiki category."""
    all_files = []
    continue_token = None
    
    print(f"    Fetching file list from {category_name}...")
    
    while True:
        params = {
            'action': 'query',
            'format': 'json',
            'list': 'categorymembers',
            'cmtitle': category_name,
            'cmtype': 'file',
            'cmlimit': '500'
        }
        if continue_token:
            params['cmcontinue'] = continue_token
        
        data = wiki_api_request(params)
        if not data:
            break
        
        members = data.get('query', {}).get('categorymembers', [])
        all_files.extend(members)
        
        if 'continue' in data:
            continue_token = data['continue'].get('cmcontinue')
        else:
            break
    
    return all_files

def get_allimages_by_prefix(prefix):
    """Use allimages API to find all files starting with a given prefix."""
    all_images = []
    continue_from = None
    
    while True:
        params = {
            'action': 'query',
            'format': 'json',
            'list': 'allimages',
            'aiprefix': prefix,
            'ailimit': '500'
        }
        if continue_from:
            params['aicontinue'] = continue_from
        
        data = wiki_api_request(params)
        if not data:
            break
        
        images = data.get('query', {}).get('allimages', [])
        for img in images:
            all_images.append({
                'name': img['name'],
                'url': img.get('url', '')
            })
        
        if 'continue' in data:
            continue_from = data['continue'].get('aicontinue')
        else:
            break
    
    return all_images

def get_image_url(file_title):
    """Get direct URL for a file using imageinfo API."""
    params = {
        'action': 'query',
        'format': 'json',
        'titles': file_title,
        'prop': 'imageinfo',
        'iiprop': 'url'
    }
    
    data = wiki_api_request(params)
    if not data:
        return None
    
    pages = data.get('query', {}).get('pages', {})
    for page_id, page_data in pages.items():
        imageinfo = page_data.get('imageinfo', [])
        if imageinfo:
            return imageinfo[0].get('url')
    
    return None

def download_image_file(url, folder_path, filename):
    """Download a file if it doesn't exist."""
    full_path = os.path.join(folder_path, filename)
    
    if os.path.exists(full_path):
        return 'exists'
    
    try:
        time.sleep(REQUEST_DELAY)
        response = cf_requests.get(url, impersonate='chrome')
        
        if response.status_code == 200:
            with open(full_path, 'wb') as f:
                f.write(response.content)
            return 'downloaded'
        else:
            return f'error:{response.status_code}'
    except Exception as e:
        return f'error:{e}'

def download_portraits():
    """Download killer and survivor portraits using allimages API."""
    print("\n[*] Processing CHARACTER PORTRAITS")
    
    all_portraits = {'killers': [], 'survivors': []}
    
    for prefix in ['K', 'S']:
        category = 'killers' if prefix == 'K' else 'survivors'
        print(f"    Scanning for {category} portraits...")
        
        all_images = get_allimages_by_prefix(prefix)
        
        for img in all_images:
            name = img['name']
            # Match K##_*Portrait.png or S##_*Portrait.png
            if re.match(r'^[KS]\d{2}_[^_]+_Portrait\.png$', name):
                all_portraits[category].append(img)
        
        all_portraits[category].sort(key=lambda x: x['name'])
        print(f"    Found {len(all_portraits[category])} {category} portraits")
    
    # Download portraits
    for category in ['killers', 'survivors']:
        print(f"\n    [{category.upper()}]")
        folder_path = os.path.join(IMAGES_OUTPUT_DIR, category)
        downloaded = 0
        
        for portrait in all_portraits[category]:
            filename = portrait['name']
            url = portrait['url']
            
            if not url:
                url = get_image_url(f"File:{filename}")
            
            if url:
                result = download_image_file(url, folder_path, filename)
                if result == 'downloaded':
                    print(f"    ✓ {filename}")
                    downloaded += 1
                elif result != 'exists':
                    print(f"    ✗ {filename} ({result})")
        
        print(f"    → Downloaded {downloaded} new {category} portraits")

def download_perks():
    """Download all perk images using allimages API."""
    print("\n[*] Processing PERK IMAGES")
    print("    Scanning for perk images...")
    
    all_perks = get_allimages_by_prefix('IconPerks')
    all_perks += get_allimages_by_prefix('T_UI_iconPerks')
    all_perks += get_allimages_by_prefix('T_UI_iconsPerks')

    # Filter to .png files only
    all_perks = [p for p in all_perks if p['name'].endswith('.png')]
    all_perks.sort(key=lambda x: x['name'])
    
    print(f"    Found {len(all_perks)} perk files on wiki")
    
    folder_path = os.path.join(IMAGES_OUTPUT_DIR, 'perks')
    downloaded = 0
    
    for perk in all_perks:
        filename = perk['name']
        url = perk['url']
        
        if not url:
            url = get_image_url(f"File:{filename}")
        
        if url:
            result = download_image_file(url, folder_path, filename)
            if result == 'downloaded':
                print(f"    ✓ {filename}")
                downloaded += 1
            elif result != 'exists':
                print(f"    ✗ {filename} ({result})")
    
    print(f"    → Downloaded {downloaded} new perk images")

def download_maps():
    """Download all map images using allimages API."""
    print("\n[*] Processing MAP IMAGES")
    print("    Scanning for map icons...")
    
    map_files = get_allimages_by_prefix('IconMap')
    
    # Filter to current maps (exclude old variants)
    current_maps = [m for m in map_files if '_old' not in m['name'].lower()]
    current_maps = [m for m in current_maps if m['name'].endswith('.png')]
    
    print(f"    Found {len(current_maps)} map files")
    
    folder_path = os.path.join(IMAGES_OUTPUT_DIR, 'maps')
    downloaded = 0
    
    for map_info in current_maps:
        filename = map_info['name']
        url = map_info['url']
        
        if not url:
            url = get_image_url(f"File:{filename}")
        
        if url:
            result = download_image_file(url, folder_path, filename)
            if result == 'downloaded':
                print(f"    ✓ {filename}")
                downloaded += 1
            elif result != 'exists':
                print(f"    ✗ {filename} ({result})")
    
    print(f"    → Downloaded {downloaded} new map images")

def download_items():
    """Download all item images using allimages API."""
    print("\n[*] Processing ITEM IMAGES")
    print("    Scanning for item icons...")
    
    item_files = get_allimages_by_prefix('IconItems')
    item_files += get_allimages_by_prefix('T_UI_iconItems')

    # Filter to .png files only
    item_files = [i for i in item_files if i['name'].endswith('.png')]
    item_files.sort(key=lambda x: x['name'])
    
    print(f"    Found {len(item_files)} item files on wiki")
    
    folder_path = os.path.join(IMAGES_OUTPUT_DIR, 'items')
    downloaded = 0
    
    for item in item_files:
        filename = item['name']
        url = item['url']
        
        if not url:
            url = get_image_url(f"File:{filename}")
        
        if url:
            result = download_image_file(url, folder_path, filename)
            if result == 'downloaded':
                print(f"    ✓ {filename}")
                downloaded += 1
            elif result != 'exists':
                print(f"    ✗ {filename} ({result})")
    
    print(f"    → Downloaded {downloaded} new item images")

def download_offerings():
    """Download all offering images using allimages API."""
    print("\n[*] Processing OFFERING IMAGES")
    print("    Scanning for offering icons...")
    
    offering_files = get_allimages_by_prefix('IconFavors')
    
    # Filter to .png files only
    offering_files = [o for o in offering_files if o['name'].endswith('.png')]
    offering_files.sort(key=lambda x: x['name'])
    
    print(f"    Found {len(offering_files)} offering files on wiki")
    
    folder_path = os.path.join(IMAGES_OUTPUT_DIR, 'offerings')
    downloaded = 0
    
    for offering in offering_files:
        filename = offering['name']
        url = offering['url']
        
        if not url:
            url = get_image_url(f"File:{filename}")
        
        if url:
            result = download_image_file(url, folder_path, filename)
            if result == 'downloaded':
                print(f"    ✓ {filename}")
                downloaded += 1
            elif result != 'exists':
                print(f"    ✗ {filename} ({result})")
    
    print(f"    → Downloaded {downloaded} new offering images")

def download_addons():
    """Download all addon images using allimages API."""
    print("\n[*] Processing ADDON IMAGES")
    print("    Scanning for addon icons...")
    
    addon_files = get_allimages_by_prefix('IconAddon')
    addon_files += get_allimages_by_prefix('T_UI_iconAddon')

    # Filter to .png files only
    addon_files = [a for a in addon_files if a['name'].endswith('.png')]
    addon_files.sort(key=lambda x: x['name'])
    
    print(f"    Found {len(addon_files)} addon files on wiki")
    
    folder_path = os.path.join(IMAGES_OUTPUT_DIR, 'addons')
    downloaded = 0
    
    for addon in addon_files:
        filename = addon['name']
        url = addon['url']
        
        if not url:
            url = get_image_url(f"File:{filename}")
        
        if url:
            result = download_image_file(url, folder_path, filename)
            if result == 'downloaded':
                print(f"    ✓ {filename}")
                downloaded += 1
            elif result != 'exists':
                print(f"    ✗ {filename} ({result})")
    
    print(f"    → Downloaded {downloaded} new addon images")

def scrape_images():
    """Main image scraping function."""
    if not HAS_CURL_CFFI:
        print("\n[!] Image scraping disabled: curl_cffi not installed")
        print("    Install with: pip install curl_cffi")
        return
    
    print("\n" + "=" * 60)
    print("   IMAGE SCRAPING (from wiki.gg)")
    print("=" * 60)
    
    setup_image_directories()
    download_portraits()
    download_perks()
    download_maps()
    download_items()
    download_offerings()
    download_addons()
    
    print(f"\n[✓] Images saved to '{os.path.abspath(IMAGES_OUTPUT_DIR)}'")
    
    # Show summary
    print("\n[*] Image counts:")
    for folder in ['killers', 'survivors', 'perks', 'maps', 'items', 'offerings', 'addons']:
        folder_path = os.path.join(IMAGES_OUTPUT_DIR, folder)
        if os.path.exists(folder_path):
            files = [f for f in os.listdir(folder_path) if f.endswith('.png')]
            print(f"    {folder}: {len(files)} files")

# =============================================================================
# MAIN ENTRY POINT
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Dead by Daylight MEGA SCRAPER - All-in-one data and asset scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python dbd_mega_scraper.py              # Run everything
  python dbd_mega_scraper.py --data-only  # Only scrape JSON data
  python dbd_mega_scraper.py --images-only # Only download images
        """
    )
    parser.add_argument('--data-only', action='store_true', help='Only scrape JSON data (skip images)')
    parser.add_argument('--images-only', action='store_true', help='Only download images (skip data)')
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("   DEAD BY DAYLIGHT - MEGA SCRAPER")
    print("   All-in-one data and asset scraper")
    print("=" * 60)
    
    if args.data_only:
        scrape_data()
    elif args.images_only:
        scrape_images()
    else:
        scrape_data()
        scrape_images()
    
    print("\n" + "=" * 60)
    print("   JOB COMPLETE!")
    print("=" * 60)

if __name__ == "__main__":
    main()
