const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);
const os = require('os');

async function testContainerDetection() {
    try {
        console.log('Testing container detection...\n');

        // Get list of all containers with detailed info
        console.log('1. Raw docker ps output:');
        const { stdout: containerList } = await execAsync('docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}"');
        console.log(containerList);
        console.log('\n-------------------\n');

        // Parse and filter containers
        const containers = containerList.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [name, image, ...statusParts] = line.split('\t');
                return { name, image, status: statusParts.join('\t') };
            })
            .filter(c => c.name.startsWith('rsm-msba-k8s-') || c.image.includes('vnijs/rsm-msba-k8s'));

        console.log('2. Filtered RSM containers:');
        console.log(JSON.stringify(containers, null, 2));
        console.log('\n-------------------\n');

        // Group by version
        const containersByVersion = containers.reduce((acc, c) => {
            const nameVersion = c.name.split('rsm-msba-k8s-')[1];
            const imageVersion = c.image.split(':')[1];
            const version = nameVersion || imageVersion;
            if (!acc[version]) acc[version] = [];
            acc[version].push(c);
            return acc;
        }, {});

        console.log('3. Grouped by version:');
        console.log(JSON.stringify(containersByVersion, null, 2));
        console.log('\n-------------------\n');

        // Test conflict detection for a specific version
        const testVersion = '1.0.0';
        console.log(`4. Testing conflicts for version: ${testVersion}`);
        const conflicts = containers.filter(c => {
            const nameVersion = c.name.split('rsm-msba-k8s-')[1];
            const imageVersion = c.image.split(':')[1];
            return nameVersion !== testVersion && imageVersion !== testVersion;
        });

        console.log('Potential conflicts:');
        console.log(JSON.stringify(conflicts, null, 2));

    } catch (error) {
        console.error('Error:', error.message);
    }
}

testContainerDetection(); 